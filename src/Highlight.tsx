export function Highlight({text, query}: {text: string; query: string}) {
  const term = query.trim(); if (!term) return <>{text}</>;
  const parts = [], lower = text.toLocaleLowerCase(), needle = term.toLocaleLowerCase(); let at = 0, found;
  while ((found = lower.indexOf(needle, at)) >= 0) { parts.push(text.slice(at, found), <mark key={found}>{text.slice(found, found + term.length)}</mark>); at = found + term.length; }
  return <>{parts}{text.slice(at)}</>;
}
