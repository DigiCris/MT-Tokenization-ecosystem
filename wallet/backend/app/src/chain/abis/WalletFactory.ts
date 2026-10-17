// Generado por scripts/sync-contract-artifacts.mjs desde contracts/out-abi/WalletFactory.json (sha256 f4a7da513efbb0f5c6ab5e3448db5f3b93ad5f4f18140d9e0215a4dd9b0b1f3f).
// No editar: regenerar con `pnpm sync:contracts`.
export const walletFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "cfg",
        "type": "tuple",
        "internalType": "struct WalletFactory.Config",
        "components": [
          {
            "name": "safeProxyFactory",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "safeSingleton",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "safeBootstrap",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "securityGuard",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "denyAllModuleGuard",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "rotationTimelock",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "policyRegistry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "destinationWhitelist",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "safeSingletonCodehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "safeProxyFactoryCodehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "safeProxyRuntimeCodehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "proxyCreationCodeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "chainId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "CHAIN_ID",
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
    "name": "DESTINATION_WHITELIST",
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
    "name": "POLICY_REGISTRY",
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
    "name": "PROXY_CREATION_CODE_HASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PROXY_INIT_CODE_HASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ROTATION_TIMELOCK",
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
    "name": "SAFE_BOOTSTRAP",
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
    "name": "SAFE_PROXY_FACTORY",
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
    "name": "SAFE_PROXY_FACTORY_CODEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SAFE_PROXY_RUNTIME_CODEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SAFE_SINGLETON",
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
    "name": "SAFE_SINGLETON_CODEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SAFE_VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
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
    "name": "THRESHOLD",
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
    "name": "createWallet",
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
      },
      {
        "name": "saltNonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "safe",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "initializerFor",
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
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isCreating",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "creating",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isWallet",
    "inputs": [
      {
        "name": "safe",
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
    "name": "predictWalletAddress",
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
      },
      {
        "name": "saltNonce",
        "type": "uint256",
        "internalType": "uint256"
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
    "name": "validateConfig",
    "inputs": [
      {
        "name": "cfg",
        "type": "tuple",
        "internalType": "struct WalletFactory.Config",
        "components": [
          {
            "name": "safeProxyFactory",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "safeSingleton",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "safeBootstrap",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "securityGuard",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "denyAllModuleGuard",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "rotationTimelock",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "policyRegistry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "destinationWhitelist",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "safeSingletonCodehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "safeProxyFactoryCodehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "safeProxyRuntimeCodehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "proxyCreationCodeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "chainId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifyWallet",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "ok",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "reason",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "WalletCreated",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "userKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "recoveryKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "executor",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "saltNonce",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "initializerHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AddressOccupied",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidConfig",
    "inputs": [
      {
        "name": "reason",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidKeys",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VerificationFailed",
    "inputs": [
      {
        "name": "reason",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  }
] as const;
