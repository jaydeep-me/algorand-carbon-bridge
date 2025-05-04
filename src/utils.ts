import { createHash, randomBytes } from 'crypto';
import algosdk from 'algosdk';
import { ethers } from 'ethers';
import { BigNumber } from 'bignumber.js';
import { ChainType, CarbonCreditMetadata } from './types';

/**
 * Generate a unique bridge transaction ID
 * 
 * @returns Unique bridge ID
 */
export function generateBridgeId(): string {
  // Generate a random byte array
  const randomData = randomBytes(16);
  
  // Create a timestamp component
  const timestamp = Date.now().toString();
  
  // Combine and hash to create a unique ID
  const hash = createHash('sha256')
    .update(Buffer.from(randomData))
    .update(Buffer.from(timestamp))
    .digest('hex');
  
  return hash.substring(0, 24);
}

/**
 * Convert Algorand address to proper format
 * 
 * @param address Algorand address (string or Uint8Array)
 * @returns Properly formatted Algorand address string
 */
export function formatAlgorandAddress(address: string | Uint8Array): string {
  if (typeof address === 'string') {
    if (algosdk.isValidAddress(address)) {
      return address;
    }
    throw new Error('Invalid Algorand address format');
  } else {
    return algosdk.encodeAddress(address);
  }
}

/**
 * Convert Ethereum address to proper checksum format
 * 
 * @param address Ethereum address
 * @returns Checksummed Ethereum address
 */
export function formatEthereumAddress(address: string): string {
  if (ethers.isAddress(address)) {
    return ethers.getAddress(address); // Returns checksum address
  }
  throw new Error('Invalid Ethereum address format');
}

/**
 * Format address based on chain type
 * 
 * @param address Blockchain address
 * @param chainType Type of blockchain
 * @returns Formatted address
 */
export function formatAddress(address: string, chainType: ChainType): string {
  try {
    switch (chainType) {
      case ChainType.ALGORAND:
        return formatAlgorandAddress(address);
      case ChainType.ETHEREUM:
        return formatEthereumAddress(address);
      default:
        throw new Error(`Unsupported chain type: ${chainType}`);
    }
  } catch (error: any) {
    throw new Error(`Address formatting error for ${chainType}: ${error.message}`);
  }
}

/**
 * Convert amount between chains with validation
 * 
 * @param amount Amount to convert
 * @param fromDecimals Source chain decimals
 * @param toDecimals Target chain decimals
 * @returns Converted amount
 */
export function convertAmount(
  amount: BigNumber | string | number,
  fromDecimals: number,
  toDecimals: number
): BigNumber {
  // Validate input parameters
  if (fromDecimals < 0 || toDecimals < 0) {
    throw new Error('Decimal values must be non-negative');
  }
  
  try {
    const value = new BigNumber(amount);
    
    // Check for invalid numbers
    if (!value.isFinite() || value.isNaN()) {
      throw new Error('Invalid amount value');
    }
    
    if (fromDecimals === toDecimals) {
      return value;
    }
    
    const decimalDifference = toDecimals - fromDecimals;
    const factor = new BigNumber(10).pow(Math.abs(decimalDifference));
    
    if (decimalDifference > 0) {
      return value.times(factor);
    } else {
      return value.div(factor);
    }
  } catch (error: any) {
    if (error.name === "BigNumber Error") {
      throw new Error(`BigNumber error: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Wait for a specified amount of time
 * 
 * @param ms Time to wait in milliseconds
 * @returns Promise that resolves after the specified time
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Encode metadata for on-chain storage
 * 
 * @param metadata Carbon credit metadata
 * @returns Encoded metadata string
 */
export function encodeMetadata(metadata: CarbonCreditMetadata): string {
  return Buffer.from(JSON.stringify(metadata)).toString('base64');
}

/**
 * Decode metadata from on-chain storage
 * 
 * @param encodedMetadata Encoded metadata string
 * @returns Decoded carbon credit metadata
 */
export function decodeMetadata(encodedMetadata: string): CarbonCreditMetadata {
  return JSON.parse(Buffer.from(encodedMetadata, 'base64').toString());
}

/**
 * Create a deterministic hash from transaction details
 * 
 * @param sourceChain Source chain type
 * @param targetChain Target chain type
 * @param sender Sender address
 * @param receiver Receiver address
 * @param amount Transaction amount
 * @param nonce Transaction nonce
 * @returns Deterministic transaction hash
 */
export function createTransactionHash(
  sourceChain: ChainType,
  targetChain: ChainType,
  sender: string,
  receiver: string,
  amount: string,
  nonce: number
): string {
  return createHash('sha256')
    .update(sourceChain)
    .update(targetChain)
    .update(sender)
    .update(receiver)
    .update(amount)
    .update(nonce.toString())
    .digest('hex');
}

/**
 * Format number for display
 * 
 * @param amount Amount to format
 * @param decimals Number of decimals
 * @returns Formatted number string
 */
export function formatAmount(amount: BigNumber | string | number, decimals: number = 2): string {
  return new BigNumber(amount).toFixed(decimals);
}

/**
 * Check if a transaction is older than the specified timeout
 * 
 * @param timestamp Transaction timestamp
 * @param timeoutMs Timeout in milliseconds
 * @returns True if the transaction has timed out
 */
export function isTransactionTimedOut(timestamp: number, timeoutMs: number): boolean {
  const now = Date.now();
  
  // Validate inputs
  if (isNaN(timestamp) || timestamp <= 0) {
    throw new Error('Invalid transaction timestamp');
  }
  
  if (isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid timeout value');
  }
  
  // Check for future timestamps (possible clock skew)
  if (timestamp > now + 300000) { // Allow 5 minutes of clock skew
    console.warn('Transaction timestamp is in the future, possible clock skew');
    return false;
  }
  
  return now - timestamp > timeoutMs;
}

/**
 * Calculate gas price for Ethereum transactions with surge pricing protection
 * 
 * @param baseGasPrice Base gas price in wei or gwei
 * @param maxMultiplier Maximum multiplier for gas price 
 * @param isGwei Whether the base price is in gwei
 * @returns Safe gas price in wei
 */
export function calculateSafeGasPrice(baseGasPrice: string | number, maxMultiplier: number = 2, isGwei: boolean = true): string {
  const base = new BigNumber(baseGasPrice);
  
  // If price is in gwei, convert to wei
  const priceInWei = isGwei ? base.times(1e9) : base;
  
  // Apply a multiplier for surge pricing protection, but cap it
  const withSurge = priceInWei.times(Math.min(maxMultiplier, 2));
  
  // Return as string for Ethereum transactions
  return withSurge.toFixed(0);
}

/**
 * Validate carbon credit metadata
 * 
 * @param metadata Carbon credit metadata to validate
 * @returns Error message or null if valid
 */
export function validateCarbonMetadata(metadata: any): string | null {
  if (!metadata) {
    return "Metadata is required";
  }
  
  if (!metadata.projectId) {
    return "Project ID is required";
  }
  
  if (!metadata.vintage || typeof metadata.vintage !== 'number') {
    return "Valid vintage year is required";
  }
  
  if (!metadata.standard) {
    return "Carbon standard is required";
  }
  
  if (!metadata.serialNumber) {
    return "Serial number is required";
  }
  
  return null;
}

/**
 * Try to parse a value as number, falling back to original value
 * 
 * @param value Value to parse
 * @returns Parsed number or original value
 */
export function tryParseNumber(value: any): number | any {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  
  const parsed = parseFloat(value);
  return isNaN(parsed) ? value : parsed;
}

/**
 * Get the Explorer URL for a transaction based on chain type
 * 
 * @param chainType Blockchain type
 * @param txId Transaction ID
 * @param isTestnet Whether to use testnet explorer
 * @returns Explorer URL
 */
export function getExplorerUrl(chainType: ChainType, txId: string, isTestnet: boolean = false): string {
  switch (chainType) {
    case ChainType.ALGORAND:
      return isTestnet
        ? `https://testnet.algoexplorer.io/tx/${txId}`
        : `https://algoexplorer.io/tx/${txId}`;
      
    case ChainType.ETHEREUM:
      return isTestnet
        ? `https://sepolia.etherscan.io/tx/${txId}`
        : `https://etherscan.io/tx/${txId}`;
        
    default:
      return "#";
  }
}
