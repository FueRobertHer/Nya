// lib/fire/tax/rmd.ts
//
// Required minimum distributions: from each owner's RMD age, last year's
// closing tax-deferred balance (457(b) money included) over the Uniform
// Lifetime Table's divisor for the age reached this year.
//
// Not modeled: the joint table for a spouse more than 10 years younger
// who is the sole beneficiary (Treas. Reg. 1.401(a)(9)-5(d)(1)(ii)), and
// putting the first RMD off to April 1 of the next year.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import type { Statute, Uniform } from './law/types';

/** The age at which an owner born in `birthYear` starts RMDs (IRC 401(a)(9)(C)(v)). */
export function rmdAge(birthYear: number, statute: Statute): number {
  if (birthYear < 1951) return statute.rmdAges.before1951;
  if (birthYear < 1960) return statute.rmdAges.from1951;
  return statute.rmdAges.from1960;
}

/** The Uniform Lifetime Table's divisor at `age` (the last row from 120). */
export function divisor(age: number, uniform: Uniform): number {
  const i = Math.min(Math.max(0, Math.floor(age) - uniform.firstAge), uniform.divisors.length - 1);
  return uniform.divisors[i];
}

/** This year's RMD on `lastYearEnd` for an owner of `age` (0 before `startAge`). */
export function rmd(lastYearEnd: number, age: number, startAge: number, uniform: Uniform): number {
  if (age < startAge || lastYearEnd <= 0) return 0;
  return lastYearEnd / divisor(age, uniform);
}
