// Search descriptions as words, never serialized implementation metadata.
const filler = new Set('a an and are as at available all any can could do for from get give has have help how i in installed is it list loaded me my of on or our please show skills specialists team teams the these this to tools use us what which with workers'.split(' '));
const aliases = {tax: ['tax', 'taxes', 'taxation'], llc: ['llc', 'entity', 'corporate', 'formation'], lawyer: ['legal', 'contract', 'compliance'], bookkeeping: ['bookkeeping', 'accounting', 'ledger'], email: ['email', 'gmail', 'mail'], pictures: ['visual', 'screenshot', 'image']};
export function queryTerms(query = '') {
  if (typeof query !== 'string' || query.length > 8000) throw new Error('Search query must be text of at most 8,000 characters');
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(word => !filler.has(word));
}
export function searchRecords(records, query = '', text = item => [item.id ?? item.name, item.domain, item.description, ...(item.skills ?? [])].join(' ')) {
  const terms = queryTerms(query);
  if (!terms.length) return [...records];
  const exact = query.trim().toLowerCase();
  return records.map((item, order) => {
    const words = new Set(text(item).toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const score = terms.reduce((sum, term) => sum + (aliases[term] ?? [term]).some(word => words.has(word)) * 10, 0)
      + ([item.id, item.name].includes(exact) ? 1000 : 0);
    return {item, score, order};
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).map(row => row.item);
}
export function discoveryResult(all, matches, query = '', limit = all.length) {
  return {
    query, totalAvailable: all.length, matchedCount: matches.length,
    returnedCount: Math.min(limit, matches.length), filtered: queryTerms(query).length > 0,
    matches: matches.slice(0, limit), more: Math.max(0, matches.length - limit),
    guidance: matches.length ? 'These are search matches, not the whole installed catalog. Omit query to list all. Check readiness separately from account access.'
      : 'No search matches; this does not mean nothing is installed. Omit query for the full catalog, or use a short topic such as legal, tax, finance, or email.',
  };
}
