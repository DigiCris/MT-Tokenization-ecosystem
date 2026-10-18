// Generado por scripts/sync-abis.mjs desde contracts/out-abi/SecurityGuard.json: no editar a mano.
export const securityGuardAbi = [
  {
    "type": "constructor",
    "inputs": [
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
        "name": "denyAllModuleGuard",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "walletFactory",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "safeL2Singleton",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "safeProxyRuntimeCodehash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "permit2",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "predecessor",
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
    "name": "MAX_SWAP_SLIPPAGE_BPS",
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
    "name": "PERMIT2",
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
    "name": "PREDECESSOR",
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
    "name": "SAFE_L2_SINGLETON",
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
    "name": "WALLET_FACTORY",
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
    "name": "checkAfterExecution",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "success",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "checkTransaction",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "operation",
        "type": "uint8",
        "internalType": "enum Operation"
      },
      {
        "name": "safeTxGas",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "baseGas",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "gasPrice",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "gasToken",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "refundReceiver",
        "type": "address",
        "internalType": "address payable"
      },
      {
        "name": "signatures",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "msgSender",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "classifyAssisted",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "op",
        "type": "uint8",
        "internalType": "enum OpType"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "evaluateAssisted",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "role",
        "type": "uint8",
        "internalType": "enum Role"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
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
    "type": "function",
    "name": "initializeSafe",
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
    "type": "function",
    "name": "isRegistered",
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
    "name": "roleOf",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum Role"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rolesOf",
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
        "type": "tuple",
        "internalType": "struct ISecurityGuard.SafeRoles",
        "components": [
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
            "name": "initialized",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "version",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "updateRoles",
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
    "type": "event",
    "name": "GuardUpgradeExecuted",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum RotationKind"
      },
      {
        "name": "newValue",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleRotated",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "role",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum Role"
      },
      {
        "name": "oldKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RolesImported",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "predecessor",
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
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RolesSynced",
    "inputs": [
      {
        "name": "safe",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "role",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum Role"
      },
      {
        "name": "oldKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newKey",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RolesUpdated",
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
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SafeRegistered",
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
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AdminCallForbidden",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyRegistered",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ApproveExceedsBalance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ConcurrentExecution",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeadlineExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DecimalsMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DelegateCallForbidden",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DestinationNotWhitelisted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EconomicAuthorityDenied",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExecutionFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FallbackHandlerSet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GasParametersForbidden",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GuardNotInstalled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GuardUpgradeNotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDestination",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidKeys",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRotationKind",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRotationTarget",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSigner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidThreshold",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MalformedCalldata",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MigrationRoleMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MinOutBelowFloor",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ModuleGuardNotInstalled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ModulesEnabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAKeyRole",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCreatedByFactory",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwners",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSafeProxy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OperationNotPermitted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnersMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecoveryCanOnlyRevoke",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecoveryCannotTransfer",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoleNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RotationNotExecutable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RotationOldMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeConfigurationAltered",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SignaturesTooShort",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SwapPostConditionFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ThresholdMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownCosigner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnregisteredSafe",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedSignatureType",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedToken",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ValueTransferForbidden",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongExecutor",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongSingleton",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
