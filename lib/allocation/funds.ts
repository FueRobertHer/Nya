// lib/allocation/funds.ts
//
// Nya's list of broad index funds and ETFs, each with the split its mandate
// fixes: VTI tracks the whole US stock market, so it is 100% US stocks; BND
// tracks US investment-grade bonds, so 100% bonds. Plaid gives a fund a type
// but no stock and bond split, so without this list (or the person's own
// split) every fund would be unclassified.
//
// A small list, checked by hand, of funds whose mix can't drift:
//   - a fund that holds one class (a US, international or world stock index,
//     a bond index, a REIT index, a spot bitcoin fund);
//   - a fund that mixes classes only where its mandate fixes the mix: the
//     Vanguard Balanced Index (60% US total market, 40% US aggregate bonds),
//     the LifeStrategy funds and the iShares Core allocation ETFs (80/20,
//     60/40, 40/60, 30/70 stocks and bonds). Their stocks are both US and
//     international in a proportion the funds may change, so they are
//     "stocks, region unknown".
// Never a target-date fund: its mix moves every year by design, so it stays
// unclassified until the person sets a split. A world stock fund (VT) is
// 100% stocks, but its US and international shares move with markets, so
// it is "stocks, region unknown" too.
//
// Bond funds hold a little cash for flows, and index funds a few companies
// domiciled abroad; a fund is listed by what its mandate holds, which is
// what the person bought it for.
//
// Adding a fund: only one whose split is fixed by what it is required to
// hold, with its full name, and a test (test/allocation.test.ts checks every
// entry is a valid split). The person's own split for a ticker always wins.

import type { Split } from './classes';

export type FundEntry = { name: string; split: Split };

const US: Split = { 'us-stocks': 100 };
const INTL: Split = { 'intl-stocks': 100 };
const WORLD: Split = { stocks: 100 };
const BONDS: Split = { bonds: 100 };
const REAL_ESTATE: Split = { 'real-estate': 100 };
const CRYPTO: Split = { crypto: 100 };

export const FUNDS: Readonly<Record<string, FundEntry>> = {
  // US stocks: total market, large, mid and small cap indexes.
  VTI: { name: 'Vanguard Total Stock Market ETF', split: US },
  VTSAX: { name: 'Vanguard Total Stock Market Index Fund Admiral Shares', split: US },
  VITSX: { name: 'Vanguard Total Stock Market Index Fund Institutional Shares', split: US },
  VOO: { name: 'Vanguard S&P 500 ETF', split: US },
  VFIAX: { name: 'Vanguard 500 Index Fund Admiral Shares', split: US },
  VFINX: { name: 'Vanguard 500 Index Fund Investor Shares', split: US },
  VV: { name: 'Vanguard Large-Cap ETF', split: US },
  VO: { name: 'Vanguard Mid-Cap ETF', split: US },
  VIMAX: { name: 'Vanguard Mid-Cap Index Fund Admiral Shares', split: US },
  VB: { name: 'Vanguard Small-Cap ETF', split: US },
  VSMAX: { name: 'Vanguard Small-Cap Index Fund Admiral Shares', split: US },
  VXF: { name: 'Vanguard Extended Market ETF', split: US },
  VEXAX: { name: 'Vanguard Extended Market Index Fund Admiral Shares', split: US },
  SPY: { name: 'SPDR S&P 500 ETF Trust', split: US },
  IVV: { name: 'iShares Core S&P 500 ETF', split: US },
  ITOT: { name: 'iShares Core S&P Total U.S. Stock Market ETF', split: US },
  IJH: { name: 'iShares Core S&P Mid-Cap ETF', split: US },
  IJR: { name: 'iShares Core S&P Small-Cap ETF', split: US },
  IWM: { name: 'iShares Russell 2000 ETF', split: US },
  SCHB: { name: 'Schwab U.S. Broad Market ETF', split: US },
  SCHX: { name: 'Schwab U.S. Large-Cap ETF', split: US },
  SCHA: { name: 'Schwab U.S. Small-Cap ETF', split: US },
  SWTSX: { name: 'Schwab Total Stock Market Index Fund', split: US },
  SWPPX: { name: 'Schwab S&P 500 Index Fund', split: US },
  FSKAX: { name: 'Fidelity Total Market Index Fund', split: US },
  FXAIX: { name: 'Fidelity 500 Index Fund', split: US },
  FZROX: { name: 'Fidelity ZERO Total Market Index Fund', split: US },
  FNILX: { name: 'Fidelity ZERO Large Cap Index Fund', split: US },
  FSMAX: { name: 'Fidelity Extended Market Index Fund', split: US },

  // International stocks: everything outside the US, developed, emerging.
  VXUS: { name: 'Vanguard Total International Stock ETF', split: INTL },
  VTIAX: { name: 'Vanguard Total International Stock Index Fund Admiral Shares', split: INTL },
  VGTSX: { name: 'Vanguard Total International Stock Index Fund Investor Shares', split: INTL },
  VEU: { name: 'Vanguard FTSE All-World ex-US ETF', split: INTL },
  VEA: { name: 'Vanguard FTSE Developed Markets ETF', split: INTL },
  VTMGX: { name: 'Vanguard Developed Markets Index Fund Admiral Shares', split: INTL },
  VWO: { name: 'Vanguard FTSE Emerging Markets ETF', split: INTL },
  VEMAX: { name: 'Vanguard Emerging Markets Stock Index Fund Admiral Shares', split: INTL },
  VSS: { name: 'Vanguard FTSE All-World ex-US Small-Cap ETF', split: INTL },
  IXUS: { name: 'iShares Core MSCI Total International Stock ETF', split: INTL },
  IEFA: { name: 'iShares Core MSCI EAFE ETF', split: INTL },
  EFA: { name: 'iShares MSCI EAFE ETF', split: INTL },
  IEMG: { name: 'iShares Core MSCI Emerging Markets ETF', split: INTL },
  EEM: { name: 'iShares MSCI Emerging Markets ETF', split: INTL },
  SCHF: { name: 'Schwab International Equity ETF', split: INTL },
  SCHE: { name: 'Schwab Emerging Markets Equity ETF', split: INTL },
  SWISX: { name: 'Schwab International Index Fund', split: INTL },
  FTIHX: { name: 'Fidelity Total International Index Fund', split: INTL },
  FSPSX: { name: 'Fidelity International Index Fund', split: INTL },
  FZILX: { name: 'Fidelity ZERO International Index Fund', split: INTL },

  // World stocks: US and international together, in market proportions.
  VT: { name: 'Vanguard Total World Stock ETF', split: WORLD },
  VTWAX: { name: 'Vanguard Total World Stock Index Fund Admiral Shares', split: WORLD },
  ACWI: { name: 'iShares MSCI ACWI ETF', split: WORLD },

  // Bonds: aggregate, Treasury, inflation-protected and municipal indexes.
  BND: { name: 'Vanguard Total Bond Market ETF', split: BONDS },
  VBTLX: { name: 'Vanguard Total Bond Market Index Fund Admiral Shares', split: BONDS },
  BNDX: { name: 'Vanguard Total International Bond ETF', split: BONDS },
  VTABX: { name: 'Vanguard Total International Bond Index Fund Admiral Shares', split: BONDS },
  BSV: { name: 'Vanguard Short-Term Bond ETF', split: BONDS },
  BIV: { name: 'Vanguard Intermediate-Term Bond ETF', split: BONDS },
  BLV: { name: 'Vanguard Long-Term Bond ETF', split: BONDS },
  VGSH: { name: 'Vanguard Short-Term Treasury ETF', split: BONDS },
  VGIT: { name: 'Vanguard Intermediate-Term Treasury ETF', split: BONDS },
  VGLT: { name: 'Vanguard Long-Term Treasury ETF', split: BONDS },
  VTIP: { name: 'Vanguard Short-Term Inflation-Protected Securities ETF', split: BONDS },
  VTEB: { name: 'Vanguard Tax-Exempt Bond ETF', split: BONDS },
  AGG: { name: 'iShares Core U.S. Aggregate Bond ETF', split: BONDS },
  TLT: { name: 'iShares 20+ Year Treasury Bond ETF', split: BONDS },
  IEF: { name: 'iShares 7-10 Year Treasury Bond ETF', split: BONDS },
  SHY: { name: 'iShares 1-3 Year Treasury Bond ETF', split: BONDS },
  TIP: { name: 'iShares TIPS Bond ETF', split: BONDS },
  MUB: { name: 'iShares National Muni Bond ETF', split: BONDS },
  SCHZ: { name: 'Schwab U.S. Aggregate Bond ETF', split: BONDS },
  SCHP: { name: 'Schwab U.S. TIPS ETF', split: BONDS },
  SWAGX: { name: 'Schwab U.S. Aggregate Bond Index Fund', split: BONDS },
  FXNAX: { name: 'Fidelity U.S. Bond Index Fund', split: BONDS },

  // Real estate: REIT indexes.
  VNQ: { name: 'Vanguard Real Estate ETF', split: REAL_ESTATE },
  VGSLX: { name: 'Vanguard Real Estate Index Fund Admiral Shares', split: REAL_ESTATE },
  VNQI: { name: 'Vanguard Global ex-U.S. Real Estate ETF', split: REAL_ESTATE },
  SCHH: { name: 'Schwab U.S. REIT ETF', split: REAL_ESTATE },

  // Crypto: spot bitcoin funds.
  IBIT: { name: 'iShares Bitcoin Trust ETF', split: CRYPTO },
  FBTC: { name: 'Fidelity Wise Origin Bitcoin Fund', split: CRYPTO },
  GBTC: { name: 'Grayscale Bitcoin Trust ETF', split: CRYPTO },

  // Fixed mixes: stocks and bonds in proportions the fund must keep.
  VBIAX: { name: 'Vanguard Balanced Index Fund Admiral Shares', split: { 'us-stocks': 60, bonds: 40 } },
  VBINX: { name: 'Vanguard Balanced Index Fund Investor Shares', split: { 'us-stocks': 60, bonds: 40 } },
  VASGX: { name: 'Vanguard LifeStrategy Growth Fund', split: { stocks: 80, bonds: 20 } },
  VSMGX: { name: 'Vanguard LifeStrategy Moderate Growth Fund', split: { stocks: 60, bonds: 40 } },
  VSCGX: { name: 'Vanguard LifeStrategy Conservative Growth Fund', split: { stocks: 40, bonds: 60 } },
  VASIX: { name: 'Vanguard LifeStrategy Income Fund', split: { stocks: 20, bonds: 80 } },
  AOA: { name: 'iShares Core 80/20 Aggressive Allocation ETF', split: { stocks: 80, bonds: 20 } },
  AOR: { name: 'iShares Core 60/40 Balanced Allocation ETF', split: { stocks: 60, bonds: 40 } },
  AOM: { name: 'iShares Core 40/60 Moderate Allocation ETF', split: { stocks: 40, bonds: 60 } },
  AOK: { name: 'iShares Core 30/70 Conservative Allocation ETF', split: { stocks: 30, bonds: 70 } },
};

/** The list's entry for a ticker, or null. */
export function fundSplit(ticker: string): FundEntry | null {
  const t = ticker.trim().toUpperCase();
  return Object.hasOwn(FUNDS, t) ? FUNDS[t] : null;
}
