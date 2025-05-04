import { BridgeConfig, ChainType } from "./types";
import * as dotenv from "dotenv";
import algosdk from "algosdk";

dotenv.config();

/**
 * Default bridge configuration
 */
const defaultConfig: BridgeConfig = {
  algorand: {
    nodeUrl: "https://mainnet-api.algonode.cloud",
    indexerUrl: "https://mainnet-idx.algonode.cloud",
    escrowAppId: 0, // Must be provided
    carbonAssetId: 0, // Must be provided
  },
  targetChain: {
    chainType: ChainType.ETHEREUM,
    rpcUrl: "https://mainnet.infura.io/v3/your-api-key",
    bridgeContractAddress: "",
    tokenContractAddress: "",
    gasPrice: "5000000000", // 5 gwei
    gasLimit: 300000,
  },
  verifiers: [],
  minVerifierSignatures: 2,
  bridgeFee: 0.001, // 0.1%
  timeoutBlocks: 150, // ~10 minutes on Algorand
};

/**
 * Creates a bridge configuration with sensible defaults
 *
 * @param config Partial bridge configuration
 * @returns Complete bridge configuration
 */
export function createBridgeConfig(
  config: Partial<BridgeConfig>
): BridgeConfig {
  // Merge provided config with defaults
  const mergedConfig = {
    ...defaultConfig,
    ...config,
    algorand: {
      ...defaultConfig.algorand,
      ...config.algorand,
    },
    targetChain: {
      ...defaultConfig.targetChain,
      ...config.targetChain,
    },
  };

  // Validate required fields
  if (!mergedConfig.algorand.escrowAppId) {
    throw new Error("Algorand escrow application ID is required");
  }

  if (!mergedConfig.algorand.carbonAssetId) {
    throw new Error("Algorand carbon asset ID is required");
  }

  if (!mergedConfig.targetChain.bridgeContractAddress) {
    throw new Error("Target chain bridge contract address is required");
  }

  if (!mergedConfig.targetChain.tokenContractAddress) {
    throw new Error("Target chain token contract address is required");
  }

  // Create Algorand account from mnemonic if provided
  if (
    process.env.BRIDGE_ACCOUNT_MNEMONIC &&
    !mergedConfig.algorand.bridgeAccount
  ) {
    try {
      mergedConfig.algorand.bridgeAccount = algosdk.mnemonicToSecretKey(
        process.env.BRIDGE_ACCOUNT_MNEMONIC
      );
    } catch (error) {
      console.warn("Failed to create Algorand account from mnemonic:", error);
    }
  }

  // Validate verifiers
  if (mergedConfig.verifiers.length < mergedConfig.minVerifierSignatures) {
    throw new Error(
      "Number of verifiers must be greater than or equal to minimum required signatures"
    );
  }

  return mergedConfig;
}

/**
 * Load configuration from environment variables
 */
export function loadConfigFromEnv(): Partial<BridgeConfig> {
  return {
    algorand: {
      nodeUrl: process.env.ALGORAND_NODE_URL,
      indexerUrl: process.env.ALGORAND_INDEXER_URL,
      escrowAppId: process.env.ALGORAND_ESCROW_APP_ID
        ? parseInt(process.env.ALGORAND_ESCROW_APP_ID)
        : undefined,
      carbonAssetId: process.env.ALGORAND_CARBON_ASSET_ID
        ? parseInt(process.env.ALGORAND_CARBON_ASSET_ID)
        : undefined,
    },
    targetChain: {
      chainType:
        (process.env.TARGET_CHAIN_TYPE as ChainType) || ChainType.ETHEREUM,
      rpcUrl: process.env.TARGET_CHAIN_RPC_URL,
      bridgeContractAddress: process.env.TARGET_BRIDGE_CONTRACT_ADDRESS,
      tokenContractAddress: process.env.TARGET_TOKEN_CONTRACT_ADDRESS,
      gasPrice: process.env.TARGET_GAS_PRICE,
      gasLimit: process.env.TARGET_GAS_LIMIT
        ? parseInt(process.env.TARGET_GAS_LIMIT)
        : undefined,
    },
    verifiers: process.env.VERIFIER_ADDRESSES
      ? process.env.VERIFIER_ADDRESSES.split(",")
      : [],
    minVerifierSignatures: process.env.MIN_VERIFIER_SIGNATURES
      ? parseInt(process.env.MIN_VERIFIER_SIGNATURES)
      : undefined,
    bridgeFee: process.env.BRIDGE_FEE
      ? parseFloat(process.env.BRIDGE_FEE)
      : undefined,
    timeoutBlocks: process.env.TIMEOUT_BLOCKS
      ? parseInt(process.env.TIMEOUT_BLOCKS)
      : undefined,
  };
}
