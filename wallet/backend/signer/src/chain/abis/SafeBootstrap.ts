// Generado por scripts/sync-contract-artifacts.mjs desde contracts/out-abi/SafeBootstrap.json (sha256 f92bd778d01d746654206b3ff5a7fe2149d3d9351b67348495bea45b7b78ec8e).
// No editar: regenerar con `pnpm sync:contracts`.
export const safeBootstrapAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "securityGuard",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "denyAllModuleGuard",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "DENY_ALL_MODULE_GUARD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SECURITY_GUARD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SELF",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bootstrap",
    "inputs": [
      {
        "name": "userKey",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recoveryKey",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "executor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "error",
    "name": "OnlyDelegateCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
