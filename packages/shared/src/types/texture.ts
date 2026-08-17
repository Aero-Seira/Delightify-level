export interface Texture {
  textureId: string;
  modId: string;
  originalPath: string;
  cachedPath?: string;
  width: number;
  height: number;
  extractedAt: string;
}
