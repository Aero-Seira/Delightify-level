export const SUPPORTED_MC_VERSIONS = [
  '1.21.1',
  '1.21',
  '1.20.6',
  '1.20.4',
  '1.20.1',
  '1.19.4',
  '1.19.2',
  '1.18.2',
  '1.16.5',
] as const;

export type SupportedMcVersion = (typeof SUPPORTED_MC_VERSIONS)[number];

export const MOD_LOADERS = ['forge', 'fabric', 'neoforge', 'quilt'] as const;
export type ModLoader = (typeof MOD_LOADERS)[number];

export const DEFAULT_MC_VERSION: SupportedMcVersion = '1.20.1';
export const DEFAULT_MOD_LOADER: ModLoader = 'forge';
