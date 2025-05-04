import {
  BridgeConfig,
  BridgeOptions,
  BridgeResult,
  BridgeStatus,
  BridgeTransaction,
  ChainType,
  CarbonCreditMetadata,
} from "./types";
import { AlgorandChainHandler } from "./chains/algorand";
import { EthereumChainHandler } from "./chains/ethereum";
import { bridgeEvents, BridgeEventType } from "./events";
import { createBridgeConfig, loadConfigFromEnv } from "./config";
import { generateBridgeId, formatAddress, validateCarbonMetadata } from "./utils";
import { verifyTransaction, signTransaction } from "./verification";
import { BigNumber } from "bignumber.js";

/**
 * Carbon Credit Bridge - main class for bridging operations
 */
export class CarbonCreditBridge {
  private config: BridgeConfig;
  private algorand: AlgorandChainHandler;
  private targetChain: EthereumChainHandler;
  private transactions: Map<string, BridgeTransaction> = new Map();

  /**
   * Constructor
   *
   * @param config Bridge configuration
   */
  constructor(config: Partial<BridgeConfig> = {}) {
    // Start with environment variables
    const envConfig = loadConfigFromEnv();

    // Merge with provided config
    this.config = createBridgeConfig({
      ...envConfig,
      ...config,
    });

    // Initialize chain handlers
    this.algorand = new AlgorandChainHandler(this.config);

    // Currently only supporting Ethereum as target chain
    if (this.config.targetChain.chainType === ChainType.ETHEREUM) {
      this.targetChain = new EthereumChainHandler(this.config);
    } else {
      throw new Error(
        `Unsupported target chain: ${this.config.targetChain.chainType}`
      );
    }

    // Set up event listeners
    this.setupEventListeners();
  }

  /**
   * Set up internal event listeners
   */
  private setupEventListeners() {
    bridgeEvents.onBridgeEvent(
      BridgeEventType.LOCK,
      this.handleLockEvent.bind(this)
    );
    bridgeEvents.onBridgeEvent(
      BridgeEventType.BURN,
      this.handleBurnEvent.bind(this)
    );
    bridgeEvents.onBridgeEvent(
      BridgeEventType.VERIFICATION,
      this.handleVerificationEvent.bind(this)
    );
    bridgeEvents.onBridgeEvent(
      BridgeEventType.TIMEOUT,
      this.handleTimeoutEvent.bind(this)
    );
  }

  /**
   * Handle lock event
   *
   * @param event Bridge event with transaction details
   */
  private async handleLockEvent(event: any) {
    const tx = event.transaction;

    try {
      // Store transaction
      this.transactions.set(tx.id, tx);

      // Initiate verification
      const verification = await verifyTransaction(tx, this.config);

      // If verified, mint tokens on target chain
      if (verification.isValid) {
        await this.mintOnTargetChain(tx);
      } else {
        // Emit error event
        bridgeEvents.emitBridgeEvent(BridgeEventType.ERROR, tx, {
          error: "Verification failed",
          details: verification.error,
        });
      }
    } catch (error: any) {
      console.error("Error handling lock event:", error);

      // Emit error event
      bridgeEvents.emitBridgeEvent(BridgeEventType.ERROR, tx, {
        error: error.message,
      });
    }
  }

  /**
   * Handle burn event
   *
   * @param event Bridge event with transaction details
   */
  private async handleBurnEvent(event: any) {
    const tx = event.transaction;

    try {
      // Store transaction
      this.transactions.set(tx.id, tx);

      // Initiate verification
      const verification = await verifyTransaction(tx, this.config);

      // If verified, release tokens on Algorand
      if (verification.isValid) {
        await this.releaseOnAlgorand(tx);
      } else {
        // Emit error event
        bridgeEvents.emitBridgeEvent(BridgeEventType.ERROR, tx, {
          error: "Verification failed",
          details: verification.error,
        });
      }
    } catch (error: any) {
      console.error("Error handling burn event:", error);

      // Emit error event
      bridgeEvents.emitBridgeEvent(BridgeEventType.ERROR, tx, {
        error: error.message,
      });
    }
  }

  /**
   * Handle verification event
   *
   * @param event Bridge event with transaction details
   */
  private async handleVerificationEvent(event: any) {
    // Update transaction with verification details
    const tx = this.transactions.get(event.transaction.id);
    if (tx) {
      this.transactions.set(tx.id, {
        ...tx,
        ...event.transaction,
      });
    }
  }

  /**
   * Handle timeout event
   *
   * @param event Bridge event with transaction details
   */
  private async handleTimeoutEvent(event: any) {
    const tx = event.transaction;

    // If transaction timed out, try to revert if possible
    try {
      if (
        tx.sourceChain === ChainType.ALGORAND &&
        tx.status === BridgeStatus.LOCKED
      ) {
        // Release locked tokens back to sender
        await this.algorand.releaseCarbonCredits(
          tx.id,
          tx.sender,
          tx.amount.toNumber(),
          { timeoutMs: 30000 }
        );
      }

      // Update transaction status
      tx.status = BridgeStatus.FAILED;
      this.transactions.set(tx.id, tx);
    } catch (error: any) {
      console.error("Error handling timeout:", error);
    }
  }

  /**
   * Mint tokens on target chain
   *
   * @param transaction Bridge transaction
   */
  private async mintOnTargetChain(
    transaction: BridgeTransaction
  ): Promise<void> {
    try {
      // Execute mint operation on target chain
      const result = await this.targetChain.mintWrappedCarbonCredits(
        transaction.id,
        transaction.receiver,
        transaction.amount.toString(),
        transaction.sourceTransactionId || "",
        { waitForConfirmation: true }
      );

      // Update transaction with target chain details
      if (result.success) {
        this.transactions.set(transaction.id, {
          ...transaction,
          status: BridgeStatus.MINTED,
          targetTransactionId: result.transactionId,
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error: any) {
      console.error("Error minting on target chain:", error);
      throw error;
    }
  }

  /**
   * Release tokens on Algorand
   *
   * @param transaction Bridge transaction
   */
  private async releaseOnAlgorand(
    transaction: BridgeTransaction
  ): Promise<void> {
    try {
      // Execute release operation on Algorand
      const result = await this.algorand.releaseCarbonCredits(
        transaction.id,
        transaction.receiver,
        transaction.amount.toNumber(),
        { waitForConfirmation: true }
      );

      // Update transaction with Algorand details
      if (result.success) {
        this.transactions.set(transaction.id, {
          ...transaction,
          status: BridgeStatus.RELEASED,
          targetTransactionId: result.transactionId,
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error: any) {
      console.error("Error releasing on Algorand:", error);
      throw error;
    }
  }

  /**
   * Bridge carbon credits from Algorand to target chain
   *
   * @param sender Algorand sender address
   * @param receiver Target chain receiver address
   * @param amount Amount of carbon credits to bridge
   * @param metadata Carbon credit metadata
   * @param options Bridge options
   * @returns Bridge operation result
   */
  public async bridgeToTargetChain(
    sender: string,
    receiver: string,
    amount: number | string | BigNumber,
    metadata?: CarbonCreditMetadata,
    options?: BridgeOptions
  ): Promise<BridgeResult> {
    try {
      // Input validation
      if (!sender) throw new Error("Sender address is required");
      if (!receiver) throw new Error("Receiver address is required");
      if (!amount) throw new Error("Amount is required");
      
      // Validate amount is positive
      const bnAmount = new BigNumber(amount);
      if (bnAmount.isNaN() || !bnAmount.isPositive()) {
        throw new Error("Amount must be a positive number");
      }

      // Format addresses
      const formattedSender = formatAddress(sender, ChainType.ALGORAND);
      const formattedReceiver = formatAddress(
        receiver,
        this.config.targetChain.chainType
      );

      // Convert amount to number (for Algorand)
      const amountValue = bnAmount.toNumber();

      // Validate metadata if provided
      if (metadata) {
        const metadataError = validateCarbonMetadata(metadata);
        if (metadataError) {
          throw new Error(`Invalid metadata: ${metadataError}`);
        }
      }

      // Lock carbon credits on Algorand
      const result = await this.algorand.lockCarbonCredits(
        formattedSender,
        formattedReceiver,
        amountValue,
        {
          ...options,
          metadata
        }
      );

      return result;
    } catch (error: any) {
      console.error("Error bridging to target chain:", error);
      
      // Create a detailed error response
      const errorResult: BridgeResult = {
        success: false,
        transactionId: "",
        bridgeId: "",
        status: BridgeStatus.FAILED,
        error: error.message || "Unknown error",
      };
      
      // Add stack trace in development mode
      if (process.env.NODE_ENV === 'development') {
        errorResult.receipt = {
          errorDetail: error.stack
        };
      }
      
      // Emit error event
      bridgeEvents.emitBridgeEvent(
        BridgeEventType.ERROR,
        {
          id: generateBridgeId(),
          sourceChain: ChainType.ALGORAND,
          targetChain: this.config.targetChain.chainType,
          sourceAssetId: this.config.algorand.carbonAssetId.toString(),
          targetAssetId: this.config.targetChain.tokenContractAddress,
          amount: new BigNumber(0),
          sender: sender || "unknown",
          receiver: receiver || "unknown",
          status: BridgeStatus.FAILED,
          timestamp: Date.now(),
          nonce: Date.now(),
        },
        {
          error: error.message,
          operation: "bridgeToTargetChain"
        }
      );
      
      return errorResult;
    }
  }

  /**
   * Bridge wrapped carbon credits from target chain back to Algorand
   *
   * @param sender Target chain sender address
   * @param receiver Algorand receiver address
   * @param amount Amount of wrapped carbon credits to bridge back
   * @param options Bridge options
   * @returns Bridge operation result
   */
  public async bridgeToAlgorand(
    sender: string,
    receiver: string,
    amount: number | string | BigNumber,
    options?: BridgeOptions
  ): Promise<BridgeResult> {
    try {
      // Format addresses
      const formattedSender = formatAddress(
        sender,
        this.config.targetChain.chainType
      );
      const formattedReceiver = formatAddress(receiver, ChainType.ALGORAND);

      // Convert amount to string (for Ethereum)
      const amountValue = new BigNumber(amount).toString();

      // Burn wrapped tokens on target chain
      const result = await this.targetChain.burnWrappedCarbonCredits(
        formattedSender,
        formattedReceiver,
        amountValue,
        options
      );

      return result;
    } catch (error: any) {
      console.error("Error bridging to Algorand:", error);
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
   * Get transaction by ID
   *
   * @param bridgeId Bridge transaction ID
   * @returns Bridge transaction or null if not found
   */
  public getTransaction(bridgeId: string): BridgeTransaction | undefined {
    return this.transactions.get(bridgeId);
  }

  /**
   * List all transactions
   *
   * @returns Array of bridge transactions
   */
  public listTransactions(): BridgeTransaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Get transaction status
   *
   * @param bridgeId Bridge transaction ID
   * @returns Transaction status
   */
  public async getTransactionStatus(bridgeId: string): Promise<BridgeStatus> {
    // First check local cache
    const tx = this.transactions.get(bridgeId);
    if (tx) {
      return tx.status;
    }

    // If not found locally, check both chains
    try {
      // Try Algorand first
      const algorandStatus = await this.algorand.getBridgeTransactionStatus(
        bridgeId
      );
      if (algorandStatus !== BridgeStatus.FAILED) {
        return algorandStatus;
      }

      // If not found or failed, try target chain
      return await this.targetChain.getBridgeTransactionStatus(bridgeId);
    } catch (error) {
      console.error("Error getting transaction status:", error);
      return BridgeStatus.FAILED;
    }
  }

  /**
   * Listen for bridge events
   *
   * @param type Event type
   * @param callback Callback function
   * @returns The bridge instance for chaining
   */
  public on(type: BridgeEventType | "any", callback: Function): this {
    bridgeEvents.onBridgeEvent(type, callback as any);
    return this;
  }

  /**
   * Stop listening for bridge events
   *
   * @param type Event type
   * @param callback Callback function
   * @returns The bridge instance for chaining
   */
  public off(type: BridgeEventType | "any", callback: Function): this {
    bridgeEvents.offBridgeEvent(type, callback as any);
    return this;
  }
}
