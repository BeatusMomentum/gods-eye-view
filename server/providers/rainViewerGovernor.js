/** Admit at most 80 requests in a rolling minute; return retry seconds or zero.
 * Call only at the upstream boundary, after cache lookup and coalescing. */
export function createRainViewerGovernor() {
  const attempts = [];
  return (now) => {
    while (attempts.length && now - attempts[0] >= 60_000) attempts.shift();
    if (attempts.length >= 80)
      return Math.max(1, Math.ceil((60_000 - (now - attempts[0])) / 1000));
    attempts.push(now);
    return 0;
  };
}
