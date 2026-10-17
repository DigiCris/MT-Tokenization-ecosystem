// Generado por scripts/sync-contract-artifacts.mjs desde contracts/out-abi/PolicyRegistry.json (sha256 c00d6d0a3607a53f78f4ed2d5d3fddeae0aff844799cb134f53b01b30e79ee5c).
// No editar: regenerar con `pnpm sync:contracts`.
export const policyRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "admin",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initialMode",
        "type": "uint8",
        "internalType": "enum PolicyRegistry.Mode"
      },
      {
        "name": "initialGuardians",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "permissions",
        "type": "tuple[]",
        "internalType": "struct PolicyRegistry.OpPermissionInit[]",
        "components": [
          {
            "name": "op",
            "type": "uint8",
            "internalType": "enum OpType"
          },
          {
            "name": "role",
            "type": "uint8",
            "internalType": "enum Role"
          }
        ]
      },
      {
        "name": "tokens",
        "type": "tuple[]",
        "internalType": "struct PolicyRegistry.TokenInit[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "decimals",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      },
      {
        "name": "executors",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ACTIVATION_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ADMIN",
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
    "name": "activateChange",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addGuardian",
    "inputs": [
      {
        "name": "guardian",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelChange",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "changeCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "enterRestricted",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getChange",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PolicyRegistry.Change",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum PolicyRegistry.ChangeKind"
          },
          {
            "name": "subject",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "value",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "activatesAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum PolicyRegistry.ChangeStatus"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "guardians",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isGuardian",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isMigrationAuthorized",
    "inputs": [
      {
        "name": "oldSafe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "newSafe",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isOpAllowed",
    "inputs": [
      {
        "name": "op",
        "type": "uint8",
        "internalType": "enum OpType"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isRestricted",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isSupportedToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isSwapExecutor",
    "inputs": [
      {
        "name": "executor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mode",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum PolicyRegistry.Mode"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "opPermission",
    "inputs": [
      {
        "name": "op",
        "type": "uint8",
        "internalType": "enum OpType"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "proposeGuardianAdd",
    "inputs": [
      {
        "name": "guardian",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeGuardianRemove",
    "inputs": [
      {
        "name": "guardian",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeMigrationAuthorization",
    "inputs": [
      {
        "name": "oldSafe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "newSafe",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeOpPermission",
    "inputs": [
      {
        "name": "op",
        "type": "uint8",
        "internalType": "enum OpType"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeSuccessorGuard",
    "inputs": [
      {
        "name": "guard",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "successor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeSuccessorModuleGuard",
    "inputs": [
      {
        "name": "moduleGuard",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "successor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeSupportedToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeSwapExecutor",
    "inputs": [
      {
        "name": "executor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "removeGuardian",
    "inputs": [
      {
        "name": "guardian",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeMigrationAuthorization",
    "inputs": [
      {
        "name": "oldSafe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "newSafe",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeOpPermission",
    "inputs": [
      {
        "name": "op",
        "type": "uint8",
        "internalType": "enum OpType"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeSuccessorGuard",
    "inputs": [
      {
        "name": "guard",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeSuccessorModuleGuard",
    "inputs": [
      {
        "name": "moduleGuard",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeSupportedToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeSwapExecutor",
    "inputs": [
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
    "type": "function",
    "name": "setMigrationAuthorization",
    "inputs": [
      {
        "name": "oldSafe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "newSafe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "authorized",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setOpPermission",
    "inputs": [
      {
        "name": "op",
        "type": "uint8",
        "internalType": "enum OpType"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSuccessorGuard",
    "inputs": [
      {
        "name": "guard",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "successor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSuccessorModuleGuard",
    "inputs": [
      {
        "name": "moduleGuard",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "successor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSupportedToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "supported",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSwapExecutor",
    "inputs": [
      {
        "name": "executor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "registered",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "successorGuardOf",
    "inputs": [
      {
        "name": "guard",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "successorModuleGuardOf",
    "inputs": [
      {
        "name": "moduleGuard",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "tokenDecimals",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ChangeActivated",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ChangeCancelled",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "by",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ChangeProposed",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum PolicyRegistry.ChangeKind"
      },
      {
        "name": "subject",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "target",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "activatesAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GuardianAdded",
    "inputs": [
      {
        "name": "guardian",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GuardianRemoved",
    "inputs": [
      {
        "name": "guardian",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MigrationAuthorizationSet",
    "inputs": [
      {
        "name": "oldSafe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newSafe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "authorized",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ModeRestricted",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OpPermissionSet",
    "inputs": [
      {
        "name": "op",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum OpType"
      },
      {
        "name": "role",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum Role"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Revoked",
    "inputs": [
      {
        "name": "kind",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum PolicyRegistry.ChangeKind"
      },
      {
        "name": "subject",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "target",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "by",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SuccessorGuardSet",
    "inputs": [
      {
        "name": "guard",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "successor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SuccessorModuleGuardSet",
    "inputs": [
      {
        "name": "moduleGuard",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "successor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SupportedTokenSet",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "supported",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SwapExecutorSet",
    "inputs": [
      {
        "name": "executor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "registered",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyGuardian",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyRestricted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ChangeNotMature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ChangeNotPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GuardianCannotCancelOwnRemoval",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidOpPermission",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAGuardian",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAdmin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAdminOrGuardian",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyInBootstrap",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
