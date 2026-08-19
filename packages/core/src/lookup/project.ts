/**
 * 发现整合包实例根：显式路径 > DL_PROJECT > 从 cwd 上溯 .delightify-level/project.db。
 * 纯文件系统，不读库内容。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProjectResolveSource = 'explicit' | 'env' | 'cwd';

/** 认定"这是实例根"的相对路径。默认认已建好的项目库。 */
export const PROJECT_DB_MARKER = '.delightify-level/project.db';

export interface ResolveProjectOptions {
  explicit?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * 任一存在即认定为实例根。默认 [PROJECT_DB_MARKER]。
   * import 要传快照路径：那时项目库还没建出来，只有快照能标识实例根。
   */
  markers?: readonly string[];
  /**
   * 显式路径 / DL_PROJECT 是否必须已满足 markers。默认 true。
   * import 传 false：作者指名往哪导，目录存在即可，缺快照由 importer 自己报错。
   */
  requireMarker?: boolean;
}

export interface ResolvedProject {
  projectPath: string;
  dbPath: string;
  source: ProjectResolveSource;
}

export class ProjectNotFoundError extends Error {
  readonly name = 'ProjectNotFoundError';
  constructor(message: string) {
    super(message);
  }
}

export function projectDbPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), '.delightify-level', 'project.db');
}

/** 目录满足任一 marker 即认作实例根 */
export function hasMarker(dir: string, markers: readonly string[]): boolean {
  return markers.some(marker => fs.existsSync(path.join(path.resolve(dir), marker)));
}

export function isProjectRoot(dir: string, markers: readonly string[] = [PROJECT_DB_MARKER]): boolean {
  return hasMarker(dir, markers);
}

/** 从 start 一直走到文件系统根，找第一个满足 marker 的目录 */
export function findProjectFromCwd(
  start: string,
  markers: readonly string[] = [PROJECT_DB_MARKER],
): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (isProjectRoot(dir, markers)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProject(options: ResolveProjectOptions = {}): ResolvedProject {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.explicit?.trim() || null;
  const markers = options.markers && options.markers.length > 0 ? options.markers : [PROJECT_DB_MARKER];
  const requireMarker = options.requireMarker !== false;

  const settle = (projectPath: string, source: ProjectResolveSource): ResolvedProject => ({
    projectPath,
    dbPath: projectDbPath(projectPath),
    source,
  });

  if (explicit) {
    const projectPath = path.resolve(cwd, explicit);
    if (requireMarker && !hasMarker(projectPath, markers)) {
      throw new ProjectNotFoundError(
        `项目库不存在：${projectDbPath(projectPath)}（请确认传入的是整合包实例根，且已导入过数据）`,
      );
    }
    if (!requireMarker && !fs.existsSync(projectPath)) {
      throw new ProjectNotFoundError(`目录不存在：${projectPath}`);
    }
    return settle(projectPath, 'explicit');
  }

  const fromEnv = env.DL_PROJECT?.trim();
  if (fromEnv) {
    const projectPath = path.resolve(cwd, fromEnv);
    if (requireMarker && !hasMarker(projectPath, markers)) {
      throw new ProjectNotFoundError(`DL_PROJECT=${fromEnv} 下没有项目库：${projectDbPath(projectPath)}`);
    }
    if (!requireMarker && !fs.existsSync(projectPath)) {
      throw new ProjectNotFoundError(`DL_PROJECT=${fromEnv} 指向的目录不存在：${projectPath}`);
    }
    return settle(projectPath, 'env');
  }

  const walked = findProjectFromCwd(cwd, markers);
  if (walked) return settle(walked, 'cwd');

  throw new ProjectNotFoundError(
    `找不到实例根。传入 <projectPath>、设置 DL_PROJECT，或在含 ${markers.join(' / ')} 的目录下执行。`,
  );
}
