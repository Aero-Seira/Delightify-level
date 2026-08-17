/**
 * Export backend types - MVP-0
 */

import type { ChangeSet } from './engine';

export interface KubeJsExportParams {
  changeSet: ChangeSet;
}

export interface KubeJsPreviewFileResult {
  relativePath: string;
  operationCount: number;
  content: string;
}

export interface KubeJsPreviewResult {
  operationCount: number;
  generatedAt: string;
  files: KubeJsPreviewFileResult[];
}

export interface KubeJsExportFileResult {
  filePath: string;
  operationCount: number;
}

export interface KubeJsExportResult {
  filePath: string;
  operationCount: number;
  generatedCode: string;
  writtenAt: string;
  files: KubeJsExportFileResult[];
}

export interface KubeJsRevertResult {
  filePath: string;
  deleted: boolean;
}
