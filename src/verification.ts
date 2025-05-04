import { createHash } from "crypto";
import algosdk from "algosdk";
import { ethers } from "ethers";
import {
  BridgeConfig,
  BridgeTransaction,
  VerificationResult,
  ChainType,
  BridgeDirection,
} from "./types";
import { bridgeEvents, BridgeEventType } from "./events";
import { isTransactionTimedOut, createTransactionHash } from "./utils";

/**
 * Verify bridge transaction
 *
 * @param transaction Bridge transaction
 * @param config Bridge configuration
 * @returns Verification result
 */
export async function verifyTransaction(
  transaction: BridgeTransaction,
  config: BridgeConfig
): Promise<VerificationResult> {
  try {
    // Check if transaction has timed out
    if (isTransactionTimedOut(transaction.timestamp, 3600000)) {
      // 1 hour timeout
      bridgeEvents.emitBridgeEvent(BridgeEventType.TIMEOUT, transaction);
      return {
        isValid: false,
        signatures: [],
        timestamp: Date.now(),
        error: "Transaction timed out",
      };
    }

    // Determine transaction direction
    const direction =
      transaction.sourceChain === ChainType.ALGORAND
        ? BridgeDirection.ALGORAND_TO_TARGET
        : BridgeDirection.TARGET_TO_ALGORAND;

    // Verify transaction based on direction
    let isValid = false;

    if (direction === BridgeDirection.ALGORAND_TO_TARGET) {
      // For Algorand to target chain, verify the transaction exists on Algorand
      isValid = await verifyAlgorandTransaction(transaction, config);
    } else {
      // For target to Algorand, verify the transaction exists on target chain
      isValid = await verifyTargetChainTransaction(transaction, config);
    }

    if (!isValid) {
      return {
        isValid: false,
        signatures: [],
        timestamp: Date.now(),
        error: "Transaction verification failed",
      };
    }

    // Collect signatures from verifiers
    const signatures = await collectVerifierSignatures(transaction, config);

    // Check if we have enough signatures
    const hasEnoughSignatures =
      signatures.length >= config.minVerifierSignatures;

    // Emit verification event
    bridgeEvents.emitBridgeEvent(BridgeEventType.VERIFICATION, transaction, {
      isValid: hasEnoughSignatures,
      signatures,
      timestamp: Date.now(),
    });

    return {
      isValid: hasEnoughSignatures,
      signatures,
      timestamp: Date.now(),
    };
  } catch (error: any) {
    console.error("Error verifying transaction:", error);
    return {
      isValid: false,
      signatures: [],
      timestamp: Date.now(),
      error: error.message || "Unknown verification error",
    };
  }
}

/**
 * Verify transaction on Algorand blockchain
 *
 * @param transaction Bridge transaction
 * @param config Bridge configuration
 * @returns True if transaction is valid
 */
async function verifyAlgorandTransaction(
  transaction: BridgeTransaction,
  config: BridgeConfig
): Promise<boolean> {
  try {
    if (!transaction.sourceTransactionId) {
      console.error("Missing source transaction ID");
      return false;
    }

    // Connect to Algorand node and indexer
    const algodClient = new algosdk.Algodv2(
      config.algorand.token,
      config.algorand.nodeUrl,
      config.algorand.port
    );
    
    const indexerClient = new algosdk.Indexer(
      config.algorand.token,
      config.algorand.indexerUrl,
      config.algorand.port
    );

    // Fetch transaction details from indexer
    const txnResponse = await indexerClient.lookupTransactionByID(transaction.sourceTransactionId).do();
    
    if (!txnResponse || !txnResponse.transaction) {
      console.error("Transaction not found on Algorand blockchain");
      return false;
    }

    const txn = txnResponse.transaction;
    
    // Check if transaction was confirmed
    if (txn['confirmed-round'] === undefined || txn['confirmed-round'] <= 0) {
      console.error("Transaction not confirmed");
      return false;
    }

    // For asset transfers (ASA operations)
    if (txn['tx-type'] === 'axfer') {
      // Verify it's the correct asset 
      if (txn['asset-transfer-transaction']['asset-id'] !== config.algorand.tokenId) {
        console.error("Invalid asset ID in transaction");
        return false;
      }
      
      // Verify the receiver is the escrow/bridge account
      if (txn['asset-transfer-transaction']['receiver'] !== config.algorand.escrowAddress) {
        console.error("Invalid receiver in transaction");
        return false;
      }
      
      // Verify amount
      const assetAmount = txn['asset-transfer-transaction']['amount'];
      const expectedAmount = Math.floor(
        Number(transaction.amount ?? 0) * Math.pow(10, config.algorand.decimals ?? 0)
      );
      
      if (assetAmount !== expectedAmount) {
        console.error(`Amount mismatch: expected ${expectedAmount}, got ${assetAmount}`);
        return false;
      }

      // Verify note field contains target information (if applicable)
      if (txn.note) {
        try {
          const decodedNote = Buffer.from(txn.note, 'base64').toString();
          const noteData = JSON.parse(decodedNote);
          
          if (noteData.receiver !== transaction.receiver || 
              noteData.targetChain !== transaction.targetChain) {
            console.error("Note field data mismatch");
            return false;
          }
        } catch (error) {
          console.error("Error parsing transaction note data:", error);
          return false;
        }
      }
      
      // All checks passed
      return true;
    } 
    // For app calls (smart contract interactions)
    else if (txn['tx-type'] === 'appl') {
      // Verify it's the correct application
      if (txn['application-transaction']['application-id'] !== config.algorand.escrowAppId) {
        console.error("Invalid application ID in transaction");
        return false;
      }
      
      // Get app call arguments
      const appArgs = txn['application-transaction']['application-args'] || [];
      
      // Verify the first argument is the "bridge" method (depends on your contract)
      if (appArgs.length < 1 || 
          Buffer.from(appArgs[0], 'base64').toString() !== 'bridge') {
        console.error("Invalid method call in application transaction");
        return false;
      }
      
      // Parse and verify other arguments like amount, receiver, etc.
      // The exact parsing depends on how your contract encodes these values
      
      // For example, if args[1] is amount, args[2] is receiver address:
      if (appArgs.length < 3) {
        console.error("Insufficient arguments in application call");
        return false;
      }
      
      // All checks passed
      return true;
    }
    
    console.error("Unsupported transaction type for bridging");
    return false;
    
  } catch (error) {
    console.error("Error verifying Algorand transaction:", error);
    return false;
  }
}

/**
 * Verify transaction on target blockchain
 *
 * @param transaction Bridge transaction
 * @param config Bridge configuration
 * @returns True if transaction is valid
 */
async function verifyTargetChainTransaction(
  transaction: BridgeTransaction,
  config: BridgeConfig
): Promise<boolean> {
  try {
    // Connect to the target chain RPC
    const provider = new ethers.JsonRpcProvider(config.targetChain.rpcUrl);

    if (!transaction.sourceTransactionId) {
      console.error("Missing source transaction ID");
      return false;
    }

    // Fetch the transaction receipt
    const receipt = await provider.getTransactionReceipt(transaction.sourceTransactionId);
    
    // Verify the transaction exists and was successful
    if (!receipt || receipt.status !== 1) {
      console.error("Transaction failed or not found");
      return false;
    }
    
    // Get the transaction details to verify amounts and addresses
    const tx = await provider.getTransaction(transaction.sourceTransactionId);
    if (!tx) {
      console.error("Transaction details not found");
      return false;
    }
    
    // Verify the transaction was sent to the bridge contract
    const bridgeContractAddress = config.targetChain.bridgeContractAddress;
    if (tx.to?.toLowerCase() !== bridgeContractAddress.toLowerCase()) {
      console.error(`Transaction not sent to bridge contract. Expected: ${bridgeContractAddress}, Got: ${tx.to}`);
      return false;
    }
    
    // Verify event logs for token burn/transfer events
    const relevantLogs = receipt.logs.filter(
      log => log.address.toLowerCase() === bridgeContractAddress.toLowerCase()
    );
    
    if (relevantLogs.length === 0) {
      console.error("No events from bridge contract found");
      return false;
    }
    
    // Parse event data to verify details using a more robust approach
    try {
      // Define the expected event interface
      const bridgeInterface = new ethers.Interface([
        "event TokenBridgeRequest(address indexed sender, string indexed receiver, uint256 amount, uint256 nonce)"
      ]);
      
      let foundValidEvent = false;
      
      for (const log of relevantLogs) {
        try {
          // Handle potential parsing errors for each log individually
          let parsedLog;
          try {
            parsedLog = bridgeInterface.parseLog({
              topics: log.topics as string[],
              data: log.data
            });
          } catch (parseError) {
            if (parseError instanceof Error) {
              console.log(`Skipping log - not matching our event signature: ${parseError.message}`);
            } else {
              console.log("Skipping log - not matching our event signature: Unknown error");
            }
            continue;
          }
          
          if (!parsedLog || parsedLog.name !== "TokenBridgeRequest") {
            continue;
          }
          
          // Normalize values for comparison
          const eventSender = parsedLog.args.sender.toLowerCase();
          const eventReceiver = parsedLog.args.receiver;
          const eventAmount = parsedLog.args.amount;
          const eventNonce = parsedLog.args.nonce;
          
          // Convert transaction amount to the same unit for comparison
          const transactionAmountBN = ethers.parseUnits(
            transaction.amount.toString(), 
            config.targetChain.decimals
          );
          
          // Check all parameters match
          if (eventSender !== transaction.sender.toLowerCase()) {
            console.log(`Sender mismatch: ${eventSender} vs ${transaction.sender.toLowerCase()}`);
            continue;
          }
          
          if (eventReceiver !== transaction.receiver) {
            console.log(`Receiver mismatch: ${eventReceiver} vs ${transaction.receiver}`);
            continue;
          }
          
          if (!eventAmount.eq(transactionAmountBN)) {
            console.log(`Amount mismatch: ${eventAmount.toString()} vs ${transactionAmountBN.toString()}`);
            continue;
          }
          
          if (eventNonce.toString() !== transaction.nonce.toString()) {
            console.log(`Nonce mismatch: ${eventNonce.toString()} vs ${transaction.nonce.toString()}`);
            continue;
          }
          
          // All checks passed for this event
          foundValidEvent = true;
          break;
        } catch (logError) {
          console.error("Error processing log:", logError);
          continue; // Try next log
        }
      }
      
      if (!foundValidEvent) {
        console.error("No valid bridge event found with matching parameters");
        return false;
      }
      
      return true;
    } catch (eventError) {
      console.error("Error parsing events:", eventError);
      return false;
    }
  } catch (error) {
    console.error("Error verifying target chain transaction:", error);
    return false;
  }
}

/**
 * Collect signatures from verifiers
 *
 * @param transaction Bridge transaction
 * @param config Bridge configuration
 * @returns Array of signatures
 */
async function collectVerifierSignatures(
  transaction: BridgeTransaction,
  config: BridgeConfig
): Promise<string[]> {
  // Create a hash of the transaction for signing
  const transactionHash = createTransactionHash(
    transaction.sourceChain,
    transaction.targetChain,
    transaction.sender,
    transaction.receiver,
    transaction.amount.toString(),
    transaction.nonce
  );

  const signatures: string[] = [];
  const verifierPromises: Promise<string | null>[] = [];
  const timeoutMs = 30000; // 30 second timeout for verifiers to respond
  
  // Request signatures from all verifiers
  for (const verifierUrl of config.verifiers) {
    verifierPromises.push(
      requestVerifierSignature(verifierUrl, transactionHash, timeoutMs)
    );
  }

  // Wait for all verifiers to respond (with timeout handling)
  const results = await Promise.all(verifierPromises);
  
  // Filter out null responses (failed or timed out requests)
  signatures.push(...results.filter(sig => sig !== null) as string[]);

  console.log(`Collected ${signatures.length} valid signatures from ${config.verifiers.length} verifiers`);

  return signatures;
}

/**
 * Request a signature from a verifier node
 * 
 * @param verifierUrl URL of the verifier node
 * @param transactionHash Hash of the transaction to sign
 * @param timeoutMs Timeout in milliseconds
 * @returns Signature or null if request failed
 */
async function requestVerifierSignature(
  verifierUrl: string, 
  transactionHash: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    // Create a controller for aborting the fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      // Use fetch with abort controller for better timeout handling
      const response = await fetch(`${verifierUrl}/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          transactionHash
        }),
        signal: controller.signal
      });
      
      // Clear the timeout as we got a response
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.error(`Error from verifier ${verifierUrl}: HTTP ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      
      // Verify the signature format is valid
      if (typeof data === 'object' && data !== null && 'signature' in data && typeof data.signature === 'string') {
        console.error(`Invalid signature format from verifier ${verifierUrl}`);
        return null;
      }
      
      // Add additional signature validation if needed
      if (typeof data === 'object' && data !== null && 'signature' in data && typeof data.signature === 'string') {
        return data.signature;
      }
      console.error(`Invalid signature format from verifier ${verifierUrl}`);
      return null;
    } catch (error) {
      // Clear the timeout if there was an error
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        console.error(`Request to verifier ${verifierUrl} timed out after ${timeoutMs}ms`);
      } else {
        console.error(`Error requesting signature from ${verifierUrl}:`, error);
      }
      return null;
    }
  } catch (error) {
    console.error(`Unexpected error with verifier ${verifierUrl}:`, error);
    return null;
  }
}

/**
 * Create a mock signature (for example purposes only)
 *
 * @param message Message to sign
 * @param signer Signer address
 * @returns Mock signature
 */
function createMockSignature(message: string, signer: string): string {
  return createHash("sha256")
    .update(message)
    .update(signer)
    .update(Date.now().toString())
    .digest("hex");
}

/**
 * Sign bridge transaction with private key
 *
 * @param transaction Bridge transaction
 * @param privateKey Private key for signing
 * @returns Signature
 */
export async function signTransaction(
  transaction: BridgeTransaction,
  privateKey: string
): Promise<string> {
  // Create a hash of the transaction
  const transactionHash = createTransactionHash(
    transaction.sourceChain,
    transaction.targetChain,
    transaction.sender,
    transaction.receiver,
    transaction.amount.toString(),
    transaction.nonce
  );

  // Sign the transaction hash based on the source chain
  if (transaction.sourceChain === ChainType.ALGORAND) {
    try {
      // Handle different formats of Algorand private keys
      let sk: Uint8Array;
      
      if (privateKey.length === 58 && privateKey.startsWith('PrivateKey')) {
        // Handle the case where it's already a private key object string representation
        sk = new Uint8Array(Buffer.from(privateKey.slice(10), 'base64'));
      } else if (privateKey.length === 64) {
        // Handle hex string format
        sk = new Uint8Array(Buffer.from(privateKey, 'hex'));
      } else {
        // Handle mnemonic format
        try {
          sk = algosdk.mnemonicToSecretKey(privateKey).sk;
        } catch (error) {
          if (error instanceof Error) {
            throw new Error(`Invalid Algorand private key format: ${error.message}`);
          } else {
            throw new Error("Invalid Algorand private key format: Unknown error");
          }
        }
      }
      
      // Sign message with Algorand key
      const signedBytes = algosdk.signBytes(
        new Uint8Array(Buffer.from(transactionHash)),
        sk
      );
      return Buffer.from(signedBytes).toString('base64');
    } catch (error: any) {
      throw new Error(`Algorand signing error: ${error.message}`);
    }
  } else if (transaction.sourceChain === ChainType.ETHEREUM) {
    try {
      // Create Ethereum wallet from private key
      const wallet = new ethers.Wallet(privateKey);
      
      // Sign the message properly using signMessage which returns a Promise
      const messageBytes = ethers.toUtf8Bytes(transactionHash);
      return await wallet.signMessage(messageBytes);
    } catch (error: any) {
      throw new Error(`Ethereum signing error: ${error.message}`);
    }
  } else {
    throw new Error(`Unsupported chain type: ${transaction.sourceChain}`);
  }
}

/**
 * Verify signature of a bridge transaction
 *
 * @param transaction Bridge transaction
 * @param signature Signature to verify
 * @param publicKey Public key or address of the signer
 * @returns True if signature is valid
 */
export function verifySignature(
  transaction: BridgeTransaction,
  signature: string,
  publicKey: string
): boolean {
  try {
    // Create a hash of the transaction
    const transactionHash = createTransactionHash(
      transaction.sourceChain,
      transaction.targetChain,
      transaction.sender,
      transaction.receiver,
      transaction.amount.toString(),
      transaction.nonce
    );

    // Verify the signature based on the source chain
    if (transaction.sourceChain === ChainType.ALGORAND) {
      try {
        // Convert signature from base64 to bytes
        const signatureBytes = Buffer.from(signature, 'base64');
        
        // Ensure the public key is in the correct format
        let pkBytes: Uint8Array;
        
        if (publicKey.startsWith('PublicKey')) {
          // Handle case where it's already a public key object string
          pkBytes = new Uint8Array(Buffer.from(publicKey.slice(9), 'base64'));
        } else {
          // Handle Algorand address format
          pkBytes = new Uint8Array(algosdk.decodeAddress(publicKey).publicKey);
        }
        
        // Convert to base64 which is what verifyBytes expects
        const pkBase64 = Buffer.from(pkBytes).toString('base64');
        
        // Use algosdk to verify the signature
        return algosdk.verifyBytes(
          new Uint8Array(Buffer.from(transactionHash)),
          signatureBytes,
          pkBase64
        );
      } catch (error) {
        console.error("Algorand signature verification error:", error);
        return false;
      }
    } else if (transaction.sourceChain === ChainType.ETHEREUM) {
      try {
        // For Ethereum, we need to use the same message format as during signing
        const messageBytes = ethers.toUtf8Bytes(transactionHash);
        const msgHash = ethers.hashMessage(messageBytes);
        
        // Recover the address from the signature
        const recoveredAddress = ethers.recoverAddress(msgHash, signature);
        
        // Compare to the provided public key (which should be an Ethereum address)
        return recoveredAddress.toLowerCase() === publicKey.toLowerCase();
      } catch (error) {
        console.error("Ethereum signature verification error:", error);
        return false;
      }
    } else {
      throw new Error(`Unsupported chain type: ${transaction.sourceChain}`);
    }
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}
