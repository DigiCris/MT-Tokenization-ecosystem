// Generado por scripts/sync-contract-artifacts.mjs desde contracts/out-abi/ISafeProxyFactory.json (sha256 510c05b5e27e68a0c15551cc784e12310b0450c89ba6a19d8ec4521a8e908a0c).
// No editar: regenerar con `pnpm sync:contracts`.
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
