export function cents(value) {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : null;
}

export function share(total, payers) {
  const low = Math.floor(total / payers);
  const highCount = total % payers;
  return { low, high: low + Number(highCount !== 0), lowCount: payers - highCount, highCount };
}

export function qualify(quotes, payers, ceiling) {
  return quotes.map(quote => share(quote.total, payers).high <= ceiling);
}

export function results(quotes, responses, payers) {
  if (responses.length !== payers) return null;
  return quotes.map((_, index) => responses.every(response => response[index] === true));
}

// The tightest private ceiling is at least `covered` and, when a stay is out, under `blocked`.
export function budgetBand(quotes, payers, verdict) {
  if (!Array.isArray(verdict) || verdict.length !== quotes.length) return null;
  let covered = 0;
  let blocked = null;
  for (let index = 0; index < quotes.length; index += 1) {
    const need = share(quotes[index].total, payers).high;
    if (verdict[index]) covered = Math.max(covered, need);
    else blocked = blocked === null ? need : Math.min(blocked, need);
  }
  return { covered, blocked };
}
