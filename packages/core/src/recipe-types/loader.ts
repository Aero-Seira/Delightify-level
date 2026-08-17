/**
 * 配方类型元数据加载服务
 * 
 * 负责加载和缓存 config/recipe_types 目录下的配方类型定义
 * 支持 builtin + custom 热加载
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { RecipeTypeMetadata, RecipeTypeConfig } from '@delightify/shared';

// 配方类型元数据缓存
const metadataCache = new Map<string, RecipeTypeMetadata>();
let lastLoadTime = 0;
const CACHE_TTL = 5000; // 5秒缓存

/**
 * 获取配方类型配置目录
 */
function getRecipeTypesDir(): string {
  // 开发环境：项目根目录
  const devPath = path.join(process.cwd(), 'config', 'recipe_types');
  
  // 生产环境：资源目录
  const prodPath = path.join(__dirname, '..', '..', '..', 'config', 'recipe_types');
  
  // 返回存在的路径，优先开发路径
  return devPath;
}

/**
 * 加载单个配方类型配置文件
 */
async function loadRecipeTypeFile(filePath: string): Promise<RecipeTypeMetadata[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const config: RecipeTypeConfig = JSON.parse(content);
    
    // 为每个配方类型添加所属模组信息
    return config.recipeTypes.map(rt => ({
      ...rt,
      modId: config.modInfo.modId,
    }));
  } catch (error) {
    console.error(`[RecipeTypes] Failed to load ${filePath}:`, error);
    return [];
  }
}

/**
 * 加载所有配方类型元数据
 */
export async function loadAllRecipeTypes(): Promise<RecipeTypeMetadata[]> {
  const now = Date.now();
  
  // 检查缓存是否有效
  if (now - lastLoadTime < CACHE_TTL && metadataCache.size > 0) {
    console.log('[RecipeTypes] Using cached metadata');
    return Array.from(metadataCache.values());
  }
  
  const recipeTypesDir = getRecipeTypesDir();
  const allTypes: RecipeTypeMetadata[] = [];
  
  try {
    // 加载 builtin 配方类型
    const builtinDir = path.join(recipeTypesDir, 'builtin');
    const builtinFiles = await fs.readdir(builtinDir).catch(() => []);
    
    for (const file of builtinFiles) {
      if (file.endsWith('.json')) {
        const filePath = path.join(builtinDir, file);
        const types = await loadRecipeTypeFile(filePath);
        allTypes.push(...types);
      }
    }
    
    // 加载 custom 配方类型
    const customDir = path.join(recipeTypesDir, 'custom');
    const customFiles = await fs.readdir(customDir).catch(() => []);
    
    for (const file of customFiles) {
      if (file.endsWith('.json')) {
        const filePath = path.join(customDir, file);
        const types = await loadRecipeTypeFile(filePath);
        allTypes.push(...types);
      }
    }
    
    // 更新缓存
    metadataCache.clear();
    for (const rt of allTypes) {
      metadataCache.set(rt.recipeTypeId, rt);
    }
    
    lastLoadTime = now;
    console.log(`[RecipeTypes] Loaded ${allTypes.length} recipe types`);
    
    return allTypes;
  } catch (error) {
    console.error('[RecipeTypes] Failed to load recipe types:', error);
    return [];
  }
}

/**
 * 获取单个配方类型元数据
 */
export async function getRecipeType(recipeTypeId: string): Promise<RecipeTypeMetadata | null> {
  // 确保缓存已加载
  if (metadataCache.size === 0) {
    await loadAllRecipeTypes();
  }
  
  return metadataCache.get(recipeTypeId) || null;
}

/**
 * 按模组获取配方类型
 */
export async function getRecipeTypesByMod(modId: string): Promise<RecipeTypeMetadata[]> {
  const allTypes = await loadAllRecipeTypes();
  return allTypes.filter(rt => rt.modId === modId);
}

/**
 * 清除缓存（用于热重载）
 */
export function clearRecipeTypeCache(): void {
  metadataCache.clear();
  lastLoadTime = 0;
  console.log('[RecipeTypes] Cache cleared');
}

/**
 * 获取所有配方类型ID列表
 */
export async function getAllRecipeTypeIds(): Promise<string[]> {
  const allTypes = await loadAllRecipeTypes();
  return allTypes.map(rt => rt.recipeTypeId);
}

/**
 * 获取配方类型统计信息
 */
export async function getRecipeTypeStats(): Promise<{
  total: number;
  byMod: Record<string, number>;
}> {
  const allTypes = await loadAllRecipeTypes();
  const byMod: Record<string, number> = {};
  
  for (const rt of allTypes) {
    byMod[rt.modId] = (byMod[rt.modId] || 0) + 1;
  }
  
  return {
    total: allTypes.length,
    byMod,
  };
}
