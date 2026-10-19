// Generado por scripts/sync-abis.mjs desde contracts/out-abi/ISafeProxyFactory.json: no editar a mano.
export const iSafeProxyFactoryAbi = [
  {
    "type": "function",
    "name": "createProxyWithNonceL2",
    "inputs": [
      {
        "name": "singleton",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initializer",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "saltNonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "proxy",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proxyCreationCode",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "pure"
  }
] as const;
