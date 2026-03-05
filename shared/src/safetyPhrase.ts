const WORDS = [
  "able",
  "acid",
  "aqua",
  "atom",
  "baker",
  "beacon",
  "bison",
  "bravo",
  "cabin",
  "cactus",
  "candy",
  "carpet",
  "cedar",
  "cello",
  "cobalt",
  "comet",
  "coral",
  "delta",
  "ember",
  "fable",
  "fjord",
  "flora",
  "focus",
  "gala",
  "giant",
  "globe",
  "hazel",
  "helium",
  "honey",
  "ivory",
  "jelly",
  "karma",
  "koala",
  "laser",
  "lemon",
  "lilac",
  "lunar",
  "maple",
  "mango",
  "matrix",
  "metal",
  "mimic",
  "nacho",
  "navy",
  "nebula",
  "nickel",
  "omega",
  "opera",
  "orbit",
  "panda",
  "pearl",
  "piano",
  "pilot",
  "plasma",
  "polar",
  "quantum",
  "raven",
  "river",
  "sable",
  "saturn",
  "signal",
  "solar",
  "sonic",
  "spruce",
  "stone",
  "tango",
  "tensor",
  "thunder",
  "tulip",
  "ultra",
  "vapor",
  "velvet",
  "venus",
  "vivid",
  "whale",
  "wizard",
  "xenon",
  "yodel",
  "zebra"
];

function stableKeyFingerprint(publicKeyJwk: JsonWebKey): string {
  const sorted = JSON.stringify(publicKeyJwk, Object.keys(publicKeyJwk).sort());
  return sorted;
}

export async function deriveSafetyPhrase(a: JsonWebKey, b: JsonWebKey): Promise<string> {
  const fa = stableKeyFingerprint(a);
  const fb = stableKeyFingerprint(b);
  const joined = fa < fb ? fa + "|" + fb : fb + "|" + fa;
  const bytes = new TextEncoder().encode(joined);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = new Uint8Array(digest);
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    const idx = hash[i] % WORDS.length;
    words.push(WORDS[idx]);
  }
  return words.join(" ");
}

