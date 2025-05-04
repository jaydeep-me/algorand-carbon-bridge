import { ethers } from "ethers";
import {
  BridgeConfig,
  BridgeOptions,
  BridgeResult,
  BridgeStatus,
  BridgeTransaction,
  ChainType,
} from "../../types";
import { bridgeEvents, BridgeEventType } from "../../events";
import { generateBridgeId } from "../../utils";
import { getBridgeContractABI, getTokenContractABI } from "./contracts";

/**
 * Ethereum chain handler
 */
export class EthereumChainHandler {
  private provider: ethers.JsonRpcProvider;
  private bridgeContract: ethers.Contract;
  private tokenContract: ethers.Contract;
  private config: BridgeConfig;
  private wallet: ethers.Wallet | null = null;

  /**
   * Constructor
   *
   * @param config Bridge configuration
   */
  constructor(config: BridgeConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.targetChain.rpcUrl);

    // Initialize bridge contract
    this.bridgeContract = new ethers.Contract(
      config.targetChain.bridgeContractAddress,
      getBridgeContractABI(),
      this.provider
    );

    // Initialize token contract
    this.tokenContract = new ethers.Contract(
      config.targetChain.tokenContractAddress,
      getTokenContractABI(),
      this.provider
    );

    // Initialize wallet if private key is provided
    if (process.env.BRIDGE_ETHEREUM_PRIVATE_KEY) {
      this.wallet = new ethers.Wallet(
        process.env.BRIDGE_ETHEREUM_PRIVATE_KEY,
        this.provider
      );

      // Connect contracts to wallet
      this.bridgeContract = this.bridgeContract.connect(
        this.wallet
      ) as ethers.Contract;
      this.tokenContract = this.tokenContract.connect(
        this.wallet
      ) as ethers.Contract;
    }
  }

  /**
   * Mint wrapped carbon credits on Ethereum
   *
   * @param bridgeId Bridge transaction ID
   * @param receiver Receiver address on Ethereum
   * @param amount Amount of carbon credits to mint
   * @param sourceTransactionId Source transaction ID on Algorand
   * @param options Bridge options
   * @returns Bridge operation result
   */
  async mintWrappedCarbonCredits(
    bridgeId: string,
    receiver: string,
    amount: string,
    sourceTransactionId: string,
    options?: BridgeOptions
  ): Promise<BridgeResult> {
    try {
      if (!this.wallet) {
        throw new Error("Ethereum wallet not configured");
      }

      // Validate receiver address
      if (!ethers.isAddress(receiver)) {
        throw new Error("Invalid Ethereum receiver address");
      }

      // Create transaction object
      const bridgeTransaction: BridgeTransaction = {
        id: bridgeId,
        sourceChain: ChainType.ALGORAND,
        targetChain: this.config.targetChain.chainType,
        sourceAssetId: this.config.algorand.carbonAssetId.toString(),
        targetAssetId: this.config.targetChain.tokenContractAddress,
        amount: new ethers.BigNumber(amount),
        sender: this.wallet.address,
        receiver,
        status: BridgeStatus.PENDING,
        sourceTransactionId,
        timestamp: Date.now(),
        nonce: Date.now(),
      };

      // Emit pending event
      bridgeEvents.emitBridgeEvent(BridgeEventType.MINT, bridgeTransaction);

      // Get signatures from verifiers - in a real implementation
      // this would call the signature collection service
      const signatures: string[] = [];
      
      // Set transaction options with gas price management
      const gasPrice = this.config.targetChain.gasPrice
        ? ethers.parseUnits(this.config.targetChain.gasPrice, "gwei")
        : ethers.BigNumber.from(await this.provider.send("eth_gasPrice", []));
        
      // Add a safety margin to gas price to ensure transaction doesn't get stuck
      const adjustedGasPrice = gasPrice.mul(110).div(100); // 10% increase
      
      const txOptions = {
        gasPrice: adjustedGasPrice,
        gasLimit: this.config.targetChain.gasLimit || 300000,
      };

      // Call bridge contract to mint tokens
      const tx = await this.bridgeContract.mint(
        receiver,
        ethers.parseUnits(amount, "ether"),
        bridgeId,
        sourceTransactionId,
        signatures,
        txOptions
      );

      // Wait for transaction confirmation with timeout
      const receipt = await tx.wait(2); // Wait for 2 confirmations

      // Update transaction status
      bridgeTransaction.targetTransactionId = receipt.hash;
      bridgeTransaction.status = BridgeStatus.MINTED;

      // Emit mint event
      bridgeEvents.emitBridgeEvent(BridgeEventType.MINT, bridgeTransaction, {
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        confirmations: 2,
      });

      return {
        success: true,
        transactionId: receipt.hash,
        bridgeId,
        status: BridgeStatus.MINTED,
        receipt,
      };
    } catch (error: any) {
      console.error("Error minting wrapped carbon credits:", error);
      
      // Check if error is due to gas price
      if (error.code === 'INSUFFICIENT_FUNDS') {
        return {
          success: false,
          transactionId: "",
          bridgeId,
          status: BridgeStatus.FAILED,
          error: "Insufficient ETH for gas fees",
        };
      }
      
      return {
        success: false,
        transactionId: "",
        bridgeId,
        status: BridgeStatus.FAILED,
        error: error.message || "Unknown error",
      };
    }
  }

  /**
   * Burn wrapped carbon credits on Ethereum for bridging back to Algorand
   *
   * @param sender Sender address on Ethereum
   * @param algorandReceiver Receiver address on Algorand
   * @param amount Amount of carbon credits to burn
   * @param options Bridge options
   * @returns Bridge operation result
   */
  async burnWrappedCarbonCredits(
    sender: string,
    algorandReceiver: string,
    amount: string,
    options?: BridgeOptions
  ): Promise<BridgeResult> {
    try {
      // Generate unique bridge ID
      const bridgeId = generateBridgeId();

      // Create transaction object
      const bridgeTransaction: BridgeTransaction = {
        id: bridgeId,
        sourceChain: this.config.targetChain.chainType,
        targetChain: ChainType.ALGORAND,
        sourceAssetId: this.config.targetChain.tokenContractAddress,
        targetAssetId: this.config.algorand.carbonAssetId.toString(),
        amount: ethers.BigNumber.from(
          ethers.parseUnits(amount, "ether").toString()
        ),
        sender,
        receiver: algorandReceiver,
        status: BridgeStatus.PENDING,
        timestamp: Date.now(),
        nonce: Date.now(),
      };

      // Emit pending event
      bridgeEvents.emitBridgeEvent(BridgeEventType.BURN, bridgeTransaction);

      // Create data for transaction
      const data = this.bridgeContract.interface.encodeFunctionData("burn", [
        ethers.parseUnits(amount, "ether"),
        bridgeId,
        algorandReceiver,
      ]);

      // Return unsigned transaction for user to sign
      return {
        success: true,
        transactionId: "",
        bridgeId,
        status: BridgeStatus.PENDING,
        receipt: {
          to: this.config.targetChain.bridgeContractAddress,
          data,
          value: "0x0",
          gasPrice: this.config.targetChain.gasPrice,
          gasLimit: this.config.targetChain.gasLimit,
        },
      };
    } catch (error: any) {
      console.error("Error burning wrapped carbon credits:", error);
      return {
        success: false,
        transactionId: "",
        bridgeId: "",
        status: BridgeStatus.FAILED,
        error: error.message || "Unknown error",
      };
    }
  }

  /**
   * Process burn event from Ethereum for releasing on Algorand
   *
   * @param transactionHash Ethereum transaction hash
   * @returns Bridge transaction data
   */
  async processBurnEvent(
    transactionHash: string
  ): Promise<BridgeTransaction | null> {
    try {
      // Get transaction receipt
      const receipt = await this.provider.getTransactionReceipt(
        transactionHash
      );
      if (!receipt) {
        throw new Error("Transaction not found");
      }

      // Find burn event
      const burnEvents = receipt.logs
        .filter(
          (log) =>
            log.address.toLowerCase() ===
            this.config.targetChain.bridgeContractAddress.toLowerCase()
        )
        .map((log) => {
          try {
            return this.bridgeContract.interface.parseLog({
              topics: log.topics as string[],
              data: log.data,
            });
          } catch (e) {
            return null;
          }
        })
        .filter((event) => event && event.name === "TokensBurned");

      if (burnEvents.length === 0) {
        throw new Error("Burn event not found in transaction");
      }

      const burnEvent = burnEvents[0];

      // Extract event data
      const bridgeId = burnEvent?.args[0];
      const amount = burnEvent?.args[1];
      const algorandReceiver = burnEvent?.args[2];

      // Create bridge transaction
      const bridgeTransaction: BridgeTransaction = {
        id: bridgeId,
        sourceChain: this.config.targetChain.chainType,
        targetChain: ChainType.ALGORAND,
        sourceAssetId: this.config.targetChain.tokenContractAddress,
        targetAssetId: this.config.algorand.carbonAssetId.toString(),
        amount,
        sender: receipt.from,
        receiver: algorandReceiver,
        status: BridgeStatus.BURNED,
        sourceTransactionId: transactionHash,
        timestamp: Date.now(),
        nonce: receipt.blockNumber,
      };

      // Emit burn event
      bridgeEvents.emitBridgeEvent(BridgeEventType.BURN, bridgeTransaction, {
        transactionHash,
      });

      return bridgeTransaction;
    } catch (error) {
      console.error("Error processing burn event:", error);
      return null;
    }
  }

  /**
   * Get bridge transaction status
   *
   * @param bridgeId Bridge transaction ID
   * @returns Bridge transaction status
   */
  async getBridgeTransactionStatus(bridgeId: string): Promise<BridgeStatus> {
    try {
      // Call bridge contract to get transaction status
      const status = await this.bridgeContract.getBridgeStatus(bridgeId);

      switch (status) {
        case 0:
          return BridgeStatus.PENDING;
        case 1:
          return BridgeStatus.MINTED;
        case 2:
          return BridgeStatus.BURNED;
        default:
          return BridgeStatus.PENDING;
      }
    } catch (error) {
      console.error("Error getting bridge transaction status:", error);
      return BridgeStatus.FAILED;
    }
  }
}
