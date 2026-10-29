/** A promise begun now and awaited later, its rejection marked handled
 *  meanwhile, so a failure elsewhere first can't leave it unhandled; awaiting
 *  it still throws. Begun beside other reads, Redis sends them together (its
 *  reads in the same tick share one round trip). */
export function eager<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/** `read()` begun now, as eager: a throw before it even starts is its
 *  rejection, as it would be awaited in place. */
export function begin<T>(read: () => Promise<T>): Promise<T> {
  return eager(new Promise<T>((resolve, reject) => read().then(resolve, reject)));
}
