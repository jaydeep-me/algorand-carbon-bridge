import { BridgeConfig } from "../../types";

/**
 * Get escrow smart contract TEAL code for Algorand
 *
 * @param config Bridge configuration
 * @returns Approval and clear TEAL programs
 */
export function getEscrowSmartContract(config: BridgeConfig): {
  approval: string;
  clear: string;
} {
  // Generate list of verifier addresses for TEAL
  const verifiersArray = config.verifiers
    .map((addr) => `addr ${addr}`)
    .join("\n");

  const approval = `#pragma version 6
// Carbon Credit Bridge Escrow
// Handles locking/releasing carbon credits for cross-chain bridging

// Transaction Types
txn ApplicationID
int 0
==
bnz handle_creation

// Handle app calls
txn OnCompletion
int NoOp
==
bnz handle_noop

// Handle updates and deletions (restricted to creator)
txn OnCompletion
int UpdateApplication
==
txn OnCompletion
int DeleteApplication
==
||
txn Sender
global CreatorAddress
==
&&
bnz handle_update_delete

// Reject all other calls
err

// Handle app creation
handle_creation:
  // Initialize global state
  byte "bridge_admin"
  global CreatorAddress
  app_global_put
  
  // Initialize carbon asset ID
  byte "carbon_asset_id"
  int ${config.algorand.carbonAssetId}
  app_global_put
  
  // Initialize min verifier signatures
  byte "min_verifier_signatures"
  int ${config.minVerifierSignatures}
  app_global_put
  
  // Initialize total verifiers
  byte "total_verifiers"
  int ${config.verifiers.length}
  app_global_put
  
  // Initialize bridge fee
  byte "bridge_fee"
  int ${Math.floor(
    config.bridgeFee! * 1000
  )} // Store as basis points (0.1% = 10)
  app_global_put
  
  // Initialize timeout blocks
  byte "timeout_blocks"
  int ${config.timeoutBlocks}
  app_global_put
  
  int 1
  return

// Handle application updates and deletions
handle_update_delete:
  // Only creator can update or delete
  txn Sender
  global CreatorAddress
  ==
  return

// Handle NoOp calls
handle_noop:
  // Get operation from first arg
  txna ApplicationArgs 0
  byte "lock"
  ==
  bnz handle_lock
  
  txna ApplicationArgs 0
  byte "release"
  ==
  bnz handle_release
  
  txna ApplicationArgs 0
  byte "verify"
  ==
  bnz handle_verify
  
  // Unknown operation
  err

// Handle lock operation
handle_lock:
  // Check if group transaction
  global GroupSize
  int 2
  ==
  assert
  
  // Verify first transaction is asset transfer to this app
  gtxn 0 TypeEnum
  int axfer
  ==
  assert
  
  // Verify asset ID matches carbon credit ID
  gtxn 0 XferAsset
  byte "carbon_asset_id"
  app_global_get
  ==
  assert
  
  // Verify receiver is this app's escrow account
  gtxn 0 AssetReceiver
  global CurrentApplicationAddress
  ==
  assert
  
  // Get bridge ID from arg
  txna ApplicationArgs 1
  byte "bridge_"
  concat
  
  // Store sender, receiver, amount in local storage
  dup
  byte "_sender"
  concat
  txn Sender
  app_local_put
  
  dup
  byte "_receiver"
  concat
  txna ApplicationArgs 2
  app_local_put
  
  dup
  byte "_amount"
  concat
  gtxn 0 AssetAmount
  app_local_put
  
  dup
  byte "_timestamp"
  concat
  global LatestTimestamp
  app_local_put
  
  dup
  byte "_status"
  concat
  byte "locked"
  app_local_put
  
  // Log lock event
  byte "lock_complete:"
  txna ApplicationArgs 1
  concat
  log
  
  int 1
  return

// Handle release operation
handle_release:
  // Verify sender is bridge admin
  txn Sender
  byte "bridge_admin"
  app_global_get
  ==
  assert
  
  // Get bridge ID
  txna ApplicationArgs 1
  
  // Get bridge record key
  dup
  byte "bridge_"
  swap
  concat
  
  // Check if bridge exists
  dup
  byte "_status"
  concat
  app_global_get_ex
  int 0
  ==
  bnz release_error
  
  // Verify status is "verified"
  byte "verified"
  ==
  assert
  
  // Get receiver
  dup
  byte "_receiver"
  concat
  app_global_get
  
  // Verify receiver matches arg
  txna ApplicationArgs 2
  ==
  assert
  
  // Get amount
  dup
  byte "_amount"
  concat
  app_global_get
  
  // Begin inner transaction to transfer asset
  itxn_begin
  
  // Set up asset transfer
  int axfer
  itxn_field TypeEnum
  
  byte "carbon_asset_id"
  app_global_get
  itxn_field XferAsset
  
  txna ApplicationArgs 2
  itxn_field AssetReceiver
  
  txna ApplicationArgs 3
  btoi
  itxn_field AssetAmount
  
  // Send the transaction
  itxn_submit
  
  // Update bridge status
  txna ApplicationArgs 1
  byte "bridge_"
  swap
  concat
  byte "_status"
  concat
  byte "released"
  app_global_put
  
  // Log release event
  byte "release_complete:"
  txna ApplicationArgs 1
  concat
  log
  
  int 1
  return

release_error:
  err

// Handle verify operation (from verifiers)
handle_verify:
  // Get bridge ID
  txna ApplicationArgs 1
  
  // Verify sender is a verifier
  txn Sender
  is_verifier
  assert
  
  // Get bridge record
  byte "bridge_"
  txna ApplicationArgs 1
  concat
  
  // Check if bridge exists and status is "locked"
  dup
  byte "_status"
  concat
  app_global_get
  byte "locked"
  ==
  assert
  
  // Get verifier key
  dup
  byte "_verifier_"
  concat
  txn Sender
  concat
  
  // Mark this verifier's signature
  byte "signed"
  app_global_put
  
  // Count verifier signatures
  int 0 // signature count
  int 0 // index
  
  count_signatures:
    dup
    byte "total_verifiers"
    app_global_get
    ==
    bnz check_signatures
    
    dup
    byte "_verifier_"
    byte "bridge_"
    txna ApplicationArgs 1
    concat
    concat
    
    load 0 // index
    
    // Check if this verifier has signed
    app_global_get_ex
    bnz is_signed
    
    // Not signed, continue
    int 1
    +
    b count_signatures
    
  is_signed:
    // Increment signature count
    swap
    int 1
    +
    swap
    
    // Increment index
    int 1
    +
    b count_signatures
  
  check_signatures:
    // Check if we have enough signatures
    byte "min_verifier_signatures"
    app_global_get
    >=
    bnz enough_signatures
    
    // Not enough signatures yet
    int 1
    return
  
  enough_signatures:
    // Update bridge status to verified
    byte "bridge_"
    txna ApplicationArgs 1
    concat
    byte "_status"
    concat
    byte "verified"
    app_global_put
    
    // Log verification event
    byte "verify_complete:"
    txna ApplicationArgs 1
    concat
    log
    
    int 1
    return

// Helper to check if an address is a verifier
is_verifier:
  // Function takes address from stack
  ${verifiersArray}
  ||
  ||
  return`;

  const clear = `#pragma version 6
// Carbon Credit Bridge Escrow - Clear Program
int 1
return`;

  return { approval, clear };
}

/**
 * TEAL contract for atomic swaps between Algorand and other chains
 *
 * @param targetAddress Target chain address (encoded)
 * @param sourceAddress Source Algorand address
 * @param timeout Timeout in rounds
 * @returns TEAL program
 */
export function getAtomicSwapContract(
  targetAddress: string,
  sourceAddress: string,
  timeout: number
): string {
  return `#pragma version 6
// Atomic Swap Contract for Cross-Chain Bridge
// Allows atomic swap between Algorand and target chain

// Transaction must be a payment
txn TypeEnum
int pay
==

// Verify format
txn RekeyTo
global ZeroAddress
==
&&

// Check if timeout has been reached
global Round
int ${timeout}
>
bnz timeout_reached

// Verify target address hash
txn CloseRemainderTo
global ZeroAddress
==

// Verify target chain proof is provided
txna ApplicationArgs 0
byte "${targetAddress}"
==
&&

// If all conditions pass, allow the transaction
int 1
return

// If timeout reached, allow source address to recover funds
timeout_reached:
txn CloseRemainderTo
addr ${sourceAddress}
==
return`;
}
