import {
  BookOpen, Bug, Camera, Cloud, Code, Coffee, Compass, Cpu, Database, GitBranch, Globe, Headphones,
  Heart, Layers, Leaf, Lightbulb, Palette, Rocket, Shield, Sparkles, Star, Terminal, Wrench, Zap,
  type LucideIcon,
} from "lucide-react";

import type { IconAvatarId } from "./avatar-catalog";

/** Static map: an identifier can only ever resolve to one of these components. */
export const AVATAR_ICON_COMPONENTS: Record<IconAvatarId, LucideIcon> = {
  code: Code,
  terminal: Terminal,
  cpu: Cpu,
  database: Database,
  "git-branch": GitBranch,
  bug: Bug,
  rocket: Rocket,
  zap: Zap,
  coffee: Coffee,
  palette: Palette,
  compass: Compass,
  shield: Shield,
  cloud: Cloud,
  globe: Globe,
  layers: Layers,
  wrench: Wrench,
  lightbulb: Lightbulb,
  headphones: Headphones,
  camera: Camera,
  "book-open": BookOpen,
  heart: Heart,
  star: Star,
  leaf: Leaf,
  sparkles: Sparkles,
};
