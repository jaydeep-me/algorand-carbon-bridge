import algosdk, {
  Algodv2,
  Indexer,
  makeApplicationNoOpTxnFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  Transaction,
  OnApplicationComplete,
  getApplicationAddress,
} from "algosdk";
import {
  BridgeConfig,
  BridgeOptions,
  BridgeResult,
  BridgeStatus,
  BridgeTransaction,
  ChainType,
} from "../../types";
import BigNumber from "bignumber.js";
import { bridgeEvents, BridgeEventType } from "../../events";
import { generateBridgeId } from "../../utils";
import { getEscrowSmartContract } from "./contracts";

/**
 * Algorand chain handler
 */
export class AlgorandChainHandler {
  private algodClient: Algodv2;
  private indexerClient: Indexer;
  private config: BridgeConfig;

  /**
   * Constructor
   *
   * @param config Bridge configuration
   */
  constructor(config: BridgeConfig) {
    this.config = config;
    this.algodClient = new Algodv2("", config.algorand.nodeUrl, "");
    this.indexerClient = new Indexer("", config.algorand.indexerUrl, "");
  }

  /**
   * Lock carbon credits in escrow for bridging to target chain
   *
   * @param sender Sender address
   * @param receiver Receiver address on target chain
   * @param amount Amount of carbon credits to bridge
   * @param options Bridge options
   * @returns Bridge operation result
   */
  async lockCarbonCredits(
    sender: string,
    receiver: string,
    amount: number,
    options?: BridgeOptions
  ): Promise<BridgeResult> {
    try {
      if (!this.config.algorand.bridgeAccount) {
        throw new Error("Bridge account not configured");
      }

      // Generate unique bridge ID
      const bridgeId = generateBridgeId();

      // Get suggested parameters
      const suggestedParams = await this.algodClient
        .getTransactionParams()
        .do();

      // Create asset transfer transaction to send carbon credits to escrow
      const escrowAddress = getApplicationAddress(
        this.config.algorand.escrowAppId
      );
      const assetTransferTxn =
        makeAssetTransferTxnWithSuggestedParamsFromObject({
          from: sender,
          to: escrowAddress,
          amount,
          assetIndex: this.config.algorand.carbonAssetId,
          suggestedParams,
          note: new Uint8Array(Buffer.from(`bridge:${bridgeId}:${receiver}`)),
        });

      // Create application call transaction to lock credits
      const appCallTxn = makeApplicationNoOpTxnFromObject({
        from: sender,
        appIndex: this.config.algorand.escrowAppId,
        appArgs: [
          new Uint8Array(Buffer.from("lock")),
          new Uint8Array(Buffer.from(bridgeId)),
          new Uint8Array(Buffer.from(receiver)),
        ],
        foreignAssets: [this.config.algorand.carbonAssetId],
        suggestedParams,
      });

      // Group transactions
      const txnGroup = algosdk.assignGroupID([assetTransferTxn, appCallTxn]);

      // Create transaction object
      const bridgeTransaction: BridgeTransaction = {
        id: bridgeId,
        sourceChain: ChainType.ALGORAND,
        targetChain: this.config.targetChain.chainType,
        sourceAssetId: this.config.algorand.carbonAssetId.toString(),
        targetAssetId: this.config.targetChain.tokenContractAddress, // Add targetAssetId
        amount: new BigNumber(amount),
        sender,
        receiver,
        status: BridgeStatus.PENDING,
        timestamp: Date.now(),
        nonce: suggestedParams.firstRound,
      };

      // Emit pending event
      bridgeEvents.emitBridgeEvent(BridgeEventType.LOCK, bridgeTransaction, {
        transactions: txnGroup.map((txn) =>
          algosdk.encodeUnsignedTransaction(txn)
        ),
      });

      // Return unsigned transactions
      // Note: In a real implementation, these would be signed and submitted
      return {
        success: true,
        transactionId: "", // Will be set after submission
        bridgeId,
        status: BridgeStatus.PENDING,
        receipt: {
          transactions: txnGroup.map((txn) =>
            Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
              "base64"
            )
          ),
          groupId: Buffer.from(txnGroup[0].group!).toString("base64"),
        },
      };
    } catch (error: any) {
      console.error("Error locking carbon credits:", error);
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
   * Release carbon credits from escrow back to owner
   *
   * @param bridgeId Bridge transaction ID
   * @param receiver Receiver address on Algorand
   * @param amount Amount of carbon credits to release
   * @param options Bridge options
   * @returns Bridge operation result
   */
  async releaseCarbonCredits(
    bridgeId: string,
    receiver: string,
    amount: number,
    options?: BridgeOptions
  ): Promise<BridgeResult> {
    try {
      if (!this.config.algorand.bridgeAccount) {
        throw new Error("Bridge account not configured");
      }

      // Get suggested parameters
      const suggestedParams = await this.algodClient
        .getTransactionParams()
        .do();

      // Create application call transaction to release credits
      const appCallTxn = makeApplicationNoOpTxnFromObject({
        from: this.config.algorand.bridgeAccount.addr,
        appIndex: this.config.algorand.escrowAppId,
        appArgs: [
          new Uint8Array(Buffer.from("release")),
          new Uint8Array(Buffer.from(bridgeId)),
          new Uint8Array(Buffer.from(receiver)),
          algosdk.encodeUint64(amount),
        ],
        foreignAssets: [this.config.algorand.carbonAssetId],
        suggestedParams,
      });

      // Sign transaction
      const signedTxn = algosdk.signTransaction(
        appCallTxn,
        this.config.algorand.bridgeAccount.sk
      );

      // Create transaction object
      const bridgeTransaction: BridgeTransaction = {
        id: bridgeId,
        sourceChain: this.config.targetChain.chainType,
        targetChain: ChainType.ALGORAND,
        sourceAssetId: this.config.targetChain.tokenContractAddress,
        targetAssetId: this.config.algorand.carbonAssetId.toString(),
        amount: new BigNumber(amount),
        sender: this.config.algorand.bridgeAccount.addr,
        receiver,
        status: BridgeStatus.PENDING,
        timestamp: Date.now(),
        nonce: suggestedParams.firstRound,
      };

      // Emit pending event
      bridgeEvents.emitBridgeEvent(BridgeEventType.RELEASE, bridgeTransaction, {
        transaction: Buffer.from(signedTxn.blob).toString("base64"),
      });

      // Submit transaction
      const txResponse = await this.algodClient
        .sendRawTransaction(signedTxn.blob)
        .do();

      // Update transaction status
      bridgeTransaction.sourceTransactionId = txResponse.txId;
      bridgeTransaction.status = BridgeStatus.RELEASED;

      // Emit release event
      bridgeEvents.emitBridgeEvent(BridgeEventType.RELEASE, bridgeTransaction, {
        transactionId: txResponse.txId,
      });

      return {
        success: true,
        transactionId: txResponse.txId,
        bridgeId,
        status: BridgeStatus.RELEASED,
        receipt: txResponse,
      };
    } catch (error: any) {
      console.error("Error releasing carbon credits:", error);
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
   * Get bridge transaction status
   *
   * @param bridgeId Bridge transaction ID
   * @returns Bridge transaction status
   */
  async getBridgeTransactionStatus(bridgeId: string): Promise<BridgeStatus> {
    try {
      // Query application logs for bridge transaction
      const appLogs = await this.indexerClient
        .searchForApplications()
        .index(this.config.algorand.escrowAppId)
        .do();

      // Find logs for this bridge ID
      for (const log of appLogs["logs"]) {
        for (const txLog of log["log-data"]) {
          if (txLog.includes(bridgeId)) {
            const logData = Buffer.from(txLog, "base64").toString();

            if (logData.includes("lock_complete")) {
              return BridgeStatus.LOCKED;
            } else if (logData.includes("release_complete")) {
              return BridgeStatus.RELEASED;
            }
          }
        }
      }

      return BridgeStatus.PENDING;
    } catch (error) {
      console.error("Error getting bridge transaction status:", error);
      return BridgeStatus.FAILED;
    }
  }

  /**
   * Get escrow smart contract TEAL code
   *
   * @returns Approval and clear TEAL programs
   */
  getEscrowSmartContract() {
    return getEscrowSmartContract(this.config);
  }
}
