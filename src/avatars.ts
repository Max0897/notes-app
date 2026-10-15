import type {Style} from '@dicebear/core';
let definition: Promise<Style> | undefined;
const sources = new Map<string, Promise<string>>();

export function avatarSource(seed: string): Promise<string> {
  const cached = sources.get(seed);
  if (cached) return cached;
  if (!definition) {
    definition = Promise.all([import('@dicebear/core'), import('@dicebear/styles/cutouts.json')])
      .then(([{Style}, data]) => new Style(data.default));
    void definition.catch(() => { definition = undefined; });
  }
  const source = Promise.all([import('@dicebear/core'), definition]).then(([{Avatar}, style]) => new Avatar(style, {
    seed, size: 128, idRandomization: false,
    backgroundColor: ['e8f3ff', 'e8ffea', 'fff7e8', 'f5e8ff', 'f2f3f5'],
  }).toDataUri());
  if (sources.size >= 100) sources.delete(sources.keys().next().value!);
  sources.set(seed, source);
  void source.catch(() => { sources.delete(seed); });
  return source;
}
