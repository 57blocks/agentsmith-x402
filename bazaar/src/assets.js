/** Canonical Stellar SAC addresses used by the catalog's symbol filters. */
export const NATIVE_XLM_ASSETS = {
  'stellar:testnet': 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  'stellar:pubnet': 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
};

export const USDC_ASSETS = {
  'stellar:testnet': 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  'stellar:pubnet': 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
};

export const USDC_DECIMALS = 7;

export function addressesForSymbol(symbol, network) {
  const table = symbol === 'USDC' ? USDC_ASSETS : symbol === 'XLM' ? NATIVE_XLM_ASSETS : null;
  if (!table) return [];
  return Object.entries(table)
    .filter(([chain]) => !network || chain === network)
    .map(([, address]) => address);
}

export function decimalsForAsset(asset) {
  return Object.values(USDC_ASSETS).includes(String(asset).toUpperCase()) ? USDC_DECIMALS : null;
}
