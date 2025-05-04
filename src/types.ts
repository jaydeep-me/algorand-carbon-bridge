import { Account } from "algosdk";

/**
 * Supported blockchain types
 */
export enum ChainType {
  ALGORAND = "algorand",
  ETHEREUM = "ethereum",
  // Add more chains as needed
}

/**
 * Bridge transaction status
 */
export enum BridgeStatus {
  PENDING = "pending",
  LOCKED = "locked",
  MINTED = "minted",
  BURNED = "burned",
  RELEASED = "released",
  FAILED = "failed",
}

/**
 * Transaction direction
 */
export enum BridgeDirection {
  ALGORAND_TO_TARGET = "algorand_to_target",
  TARGET_TO_ALGORAND = "target_to_algorand",
}

/**
 * Bridge transaction representation
 */
export interface BridgeTransaction {
  id: string;
  sourceChain: ChainType;
  targetChain: ChainType;
  sourceAssetId: string; // Algorand ASA ID or contract address
  targetAssetId: string; // Target chain token address
  amount: BigNumber;
  sender: string;
  receiver: string;
  status: BridgeStatus;
  sourceTransactionId?: string;
  targetTransactionId?: string;
  timestamp: number;
  nonce: number;
}

/**
 * Carbon Credit metadata
 */
export interface CarbonCreditMetadata {
  projectId: string;
  vintage: number;
  standard: string; // e.g. "Verra", "Gold Standard"
  creditType: string; // e.g. "VCU", "CRT"
  serialNumber: string;
  issuanceDate: number; // UNIX timestamp
  retirementStatus: boolean;
  additionalAttributes?: Record<string, any>;
}

/**
 * Bridge configuration interface
 */
export interface BridgeConfig {
  algorand: {
    token: string;
    port: string | number | undefined;
    tokenId?: any;
    escrowAddress: any;
    nodeUrl: string;
    indexerUrl: string;
    escrowAppId: number;
    carbonAssetId: number;
    bridgeAccount?: Account;
    decimals?: number;
  };
  targetChain: {
    decimals?: number;
    chainType: ChainType;
    rpcUrl: string;
    bridgeContractAddress: string;
    tokenContractAddress: string;
    gasPrice?: string;
    gasLimit?: number;
  };
  verifiers: string[]; // List of verifier public keys
  minVerifierSignatures: number; // Minimum required signatures
  bridgeFee?: number; // Fee for bridge operations
  timeoutBlocks: number; // Number of blocks before transaction is considered timed out
}

/**
 * Bridge operation options
 */
export interface BridgeOptions {
  waitForConfirmation?: boolean;
  timeoutMs?: number;
  callbackUrl?: string;
  metadata?: any;
}

/**
 * Result of a bridge operation
 */
export interface BridgeResult {
  success: boolean;
  transactionId: string;
  bridgeId: string;
  status: BridgeStatus;
  error?: string;
  receipt?: any;
}

/**
 * Verification result
 */
export interface VerificationResult {
  isValid: boolean;
  signatures: string[];
  timestamp: number;
  error?: string;
}

/**
 * Supported event types
 */
export enum BridgeEventType {
  LOCK = "lock",
  MINT = "mint",
  BURN = "burn",
  RELEASE = "release",
  ERROR = "error",
  TIMEOUT = "timeout",
  VERIFICATION = "verification",
}

/**
 * Bridge event interface
 */
export interface BridgeEvent {
  type: BridgeEventType;
  transaction: BridgeTransaction;
  timestamp: number;
  details?: any;
}
