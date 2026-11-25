/**
 * Curated avatar symbols. Only these identifiers are ever stored; the database
 * CHECK constraint profiles_avatar_symbol_valid holds the same lists
 * (tests/profile.test.mjs keeps them equal). Characters and icons are resolved
 * here at render time, so no user-supplied text or markup is ever displayed.
 */

export const EMOJI_AVATARS = {
  rocket: { char: "🚀", label: "Rocket" },
  laptop: { char: "💻", label: "Laptop" },
  sparkles: { char: "✨", label: "Sparkles" },
  fire: { char: "🔥", label: "Fire" },
  star: { char: "⭐", label: "Star" },
  rainbow: { char: "🌈", label: "Rainbow" },
  sun: { char: "🌞", label: "Sun" },
  moon: { char: "🌙", label: "Moon" },
  cat: { char: "🐱", label: "Cat" },
  dog: { char: "🐶", label: "Dog" },
  fox: { char: "🦊", label: "Fox" },
  panda: { char: "🐼", label: "Panda" },
  owl: { char: "🦉", label: "Owl" },
  octopus: { char: "🐙", label: "Octopus" },
  unicorn: { char: "🦄", label: "Unicorn" },
  coffee: { char: "☕", label: "Coffee" },
  pizza: { char: "🍕", label: "Pizza" },
  seedling: { char: "🌱", label: "Seedling" },
  bolt: { char: "⚡", label: "Lightning" },
  target: { char: "🎯", label: "Target" },
  brain: { char: "🧠", label: "Brain" },
  robot: { char: "🤖", label: "Robot" },
  alien: { char: "👽", label: "Alien" },
  gem: { char: "💎", label: "Gem" },
} as const satisfies Record<string, { char: string; label: string }>;

export const ICON_AVATARS = {
  code: "Code",
  terminal: "Terminal",
  cpu: "Processor",
  database: "Database",
  "git-branch": "Git branch",
  bug: "Bug",
  rocket: "Rocket",
  zap: "Lightning",
  coffee: "Coffee",
  palette: "Palette",
  compass: "Compass",
  shield: "Shield",
  cloud: "Cloud",
  globe: "Globe",
  layers: "Layers",
  wrench: "Wrench",
  lightbulb: "Light bulb",
  headphones: "Headphones",
  camera: "Camera",
  "book-open": "Book",
  heart: "Heart",
  star: "Star",
  leaf: "Leaf",
  sparkles: "Sparkles",
} as const satisfies Record<string, string>;

export type EmojiAvatarId = keyof typeof EMOJI_AVATARS;
export type IconAvatarId = keyof typeof ICON_AVATARS;

export const EMOJI_AVATAR_IDS = Object.keys(EMOJI_AVATARS) as EmojiAvatarId[];
export const ICON_AVATAR_IDS = Object.keys(ICON_AVATARS) as IconAvatarId[];

export function isEmojiAvatarId(value: unknown): value is EmojiAvatarId {
  return typeof value === "string" && Object.hasOwn(EMOJI_AVATARS, value);
}

export function isIconAvatarId(value: unknown): value is IconAvatarId {
  return typeof value === "string" && Object.hasOwn(ICON_AVATARS, value);
}
