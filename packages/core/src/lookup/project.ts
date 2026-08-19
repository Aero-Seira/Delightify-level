/**
 * 发现整合包实例根：显式路径 > DL_PROJECT > 从 cwd 上溯 .delightify-level/project.db。
 * 纯文件系统，不读库内容。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProjectResolveSource = 'explicit' | 'env' | 'cwd';

export interface ResolveProjectOptions {
  explicit?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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

export function isProjectRoot(dir: string): boolean {
  return fs.existsSync(projectDbPath(dir));
}

/** 从 start 一直走到文件系统根，找带 .delightify-level/project.db 的目录 */
export function findProjectFromCwd(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (isProjectRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProject(options: ResolveProjectOptions = {}): ResolvedProject {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.explicit?.trim() || null;

  if (explicit) {
    const projectPath = path.resolve(cwd, explicit);
    const dbPath = projectDbPath(projectPath);
    if (!fs.existsSync(dbPath)) {
      throw new ProjectNotFoundError(
        `项目库不存在：${dbPath}（请确认传入的是整合包实例根，且已导入过数据）`,
      );
    }
    return { projectPath, dbPath, source: 'explicit' };
  }

  const fromEnv = env.DL_PROJECT?.trim();
  if (fromEnv) {
    const projectPath = path.resolve(cwd, fromEnv);
    const dbPath = projectDbPath(projectPath);
    if (!fs.existsSync(dbPath)) {
      throw new ProjectNotFoundError(
        `DL_PROJECT=${fromEnv} 下没有项目库：${dbPath}`,
      );
    }
    return { projectPath, dbPath, source: 'env' };
  }

  const walked = findProjectFromCwd(cwd);
  if (walked) {
    return { projectPath: walked, dbPath: projectDbPath(walked), source: 'cwd' };
  }

  throw new ProjectNotFoundError(
    '找不到项目库。传入 <projectPath>、设置 DL_PROJECT，或在含 .delightify-level/project.db 的目录下执行。',
  );
}
