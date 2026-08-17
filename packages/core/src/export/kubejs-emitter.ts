import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ChangeOperation,
  KubeJsExportParams,
  KubeJsExportResult,
  KubeJsPreviewResult,
  KubeJsRevertResult,
} from '@delightify/shared';

export type {
  KubeJsExportParams,
  KubeJsExportResult,
  KubeJsPreviewResult,
  KubeJsRevertResult,
};

export interface GeneratedFile {
  relativePath: string;
  content: string;
  marker: string;
}

export interface KubeJsExportOptions {
  generatedAt?: string;
}

const GENERATED_MARKER = '@delightify-level-generated';
const RECIPES_RELATIVE_PATH = 'kubejs/server_scripts/zzz_delightify_level_generated.js';
const CLIENT_SCRIPTS_RELATIVE_PATH = 'kubejs/client_scripts/zzz_delightify_level_generated.js';
const GENERATED_MANIFEST_RELATIVE_PATH = 'kubejs/.delightify-level-generated.json';

function generatedFilePath(projectPath: string): string {
  return path.join(projectPath, RECIPES_RELATIVE_PATH);
}

function generatedManifestPath(projectPath: string): string {
  return path.join(projectPath, GENERATED_MANIFEST_RELATIVE_PATH);
}

function absoluteGeneratedPath(projectPath: string, relativePath: string): string {
  return path.join(projectPath, relativePath);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recipeFilter(operation: ChangeOperation): string {
  if (!operation.recipeId) {
    throw new Error(`Change operation ${operation.operationId} 缺少 recipeId`);
  }
  return `{ id: ${jsString(operation.recipeId)} }`;
}

function itemRefFromBefore(operation: ChangeOperation): string {
  const ref = optionalString(operation.before.ref) || optionalString(operation.before.itemId);
  if (!ref) {
    throw new Error(`Change operation ${operation.operationId} 缺少 before item ref`);
  }
  return ref;
}

function itemRefFromAfter(operation: ChangeOperation): string {
  const ref = optionalString(operation.after?.ref) || optionalString(operation.after?.itemId);
  if (!ref) {
    throw new Error(`Change operation ${operation.operationId} 缺少 after item ref`);
  }
  return ref;
}

function scaleRecipeJson(operation: ChangeOperation): Record<string, unknown> {
  const recipeJson = operation.after?.recipeJson as Record<string, unknown> | undefined;
  if (typeof recipeJson !== 'object' || recipeJson === null || Array.isArray(recipeJson)) {
    throw new Error(`Change operation ${operation.operationId} 缺少可重建的 recipeJson`);
  }
  const typeId = optionalString(recipeJson.type) || optionalString(operation.typeId);
  if (!typeId) {
    throw new Error(`Change operation ${operation.operationId} 缺少配方 type`);
  }
  return { ...recipeJson, type: typeId };
}

function emitScaleOperation(operation: ChangeOperation): { removeLine: string; customLine: string } {
  if (!operation.includedInChangeSet) {
    throw new Error(`Change operation ${operation.operationId} 未被纳入 change set`);
  }

  const custom = scaleRecipeJson(operation);
  return {
    removeLine: `  event.remove(${recipeFilter(operation)})`,
    customLine: `  event.custom(${JSON.stringify(custom)})`,
  };
}

function compareScaleOperation(left: ChangeOperation, right: ChangeOperation): number {
  const recipeDiff = (left.recipeId ?? '').localeCompare(right.recipeId ?? '');
  if (recipeDiff !== 0) {
    return recipeDiff;
  }
  return left.operationId.localeCompare(right.operationId);
}

function hideItemFromBefore(operation: ChangeOperation): string {
  const item = optionalString(operation.before.item) || optionalString(operation.before.ref);
  if (!item) {
    throw new Error(`Change operation ${operation.operationId} 缺少 hide item`);
  }
  return item;
}

function emitHideOperation(operation: ChangeOperation): string {
  if (!operation.includedInChangeSet) {
    throw new Error(`Change operation ${operation.operationId} 未被纳入 change set`);
  }
  return `  event.hide(${jsString(hideItemFromBefore(operation))})`;
}

function compareHideOperation(left: ChangeOperation, right: ChangeOperation): number {
  return hideItemFromBefore(left).localeCompare(hideItemFromBefore(right));
}

function emitClientScriptsFile(hideOperations: ChangeOperation[], generatedAt: string): GeneratedFile {
  return {
    relativePath: CLIENT_SCRIPTS_RELATIVE_PATH,
    marker: GENERATED_MARKER,
    content: [
      `// ${GENERATED_MARKER}`,
      '// Do not edit by hand. Regenerate from Delightify-level.',
      '// This file only affects JEI. REI / EMI users must hide items manually.',
      `// Generated at: ${generatedAt}`,
      '',
      'JEIEvents.hideItems(event => {',
      ...[...hideOperations].sort(compareHideOperation).map(emitHideOperation),
      '})',
      '',
    ].join('\n'),
  };
}

function emitRecipeOperation(operation: ChangeOperation): string {
  if (!operation.includedInChangeSet) {
    throw new Error(`Change operation ${operation.operationId} 未被纳入 change set`);
  }

  switch (operation.kind) {
    case 'replace_recipe_input_item':
      return `  event.replaceInput(${recipeFilter(operation)}, ${jsString(itemRefFromBefore(operation))}, ${jsString(itemRefFromAfter(operation))})`;
    // TODO: replaceOutput 语义/版本兼容未验证，MVP-0 不纳入 change set
    case 'replace_recipe_output_item':
      return `  event.replaceOutput(${recipeFilter(operation)}, ${jsString(itemRefFromBefore(operation))}, ${jsString(itemRefFromAfter(operation))})`;
    case 'remove_recipe':
      return `  event.remove(${recipeFilter(operation)})`;
    default:
      throw new Error(`KubeJS emitter 暂不支持操作类型: ${operation.kind}`);
  }
}

function isRecipeOperation(operation: ChangeOperation): boolean {
  return (
    operation.kind === 'replace_recipe_input_item' ||
    operation.kind === 'replace_recipe_output_item' ||
    operation.kind === 'remove_recipe'
  );
}

function isScaleOperation(operation: ChangeOperation): boolean {
  return operation.kind === 'scale_recipe_field';
}

function isHideOperation(operation: ChangeOperation): boolean {
  return operation.kind === 'hide_in_jei';
}

function isRetagOperation(operation: ChangeOperation): boolean {
  return operation.kind === 'retag_add' || operation.kind === 'retag_remove';
}

function isServerScriptOperation(operation: ChangeOperation): boolean {
  return isRecipeOperation(operation) || isScaleOperation(operation) || isRetagOperation(operation);
}

function isRenameOperation(operation: ChangeOperation): boolean {
  return operation.kind === 'rename_lang';
}

function tagRefFromBefore(operation: ChangeOperation): string {
  const tag = optionalString(operation.before.tag);
  if (!tag) {
    throw new Error(`Change operation ${operation.operationId} 缺少 tag`);
  }
  return tag;
}

function retagItemFromBefore(operation: ChangeOperation): string {
  const item = optionalString(operation.before.item) || optionalString(operation.before.ref) || optionalString(operation.before.itemId);
  if (!item) {
    throw new Error(`Change operation ${operation.operationId} 缺少 item`);
  }
  return item;
}

function emitRetagOperation(operation: ChangeOperation): string {
  if (!operation.includedInChangeSet) {
    throw new Error(`Change operation ${operation.operationId} 未被纳入 change set`);
  }

  switch (operation.kind) {
    case 'retag_add':
      return `  event.add(${jsString(tagRefFromBefore(operation))}, ${jsString(retagItemFromBefore(operation))})`;
    case 'retag_remove':
      return `  event.remove(${jsString(tagRefFromBefore(operation))}, ${jsString(retagItemFromBefore(operation))})`;
    default:
      throw new Error(`KubeJS emitter 暂不支持操作类型: ${operation.kind}`);
  }
}

function compareRetagOperation(left: ChangeOperation, right: ChangeOperation): number {
  const tagDiff = tagRefFromBefore(left).localeCompare(tagRefFromBefore(right));
  if (tagDiff !== 0) {
    return tagDiff;
  }

  const itemDiff = retagItemFromBefore(left).localeCompare(retagItemFromBefore(right));
  if (itemDiff !== 0) {
    return itemDiff;
  }

  return left.kind.localeCompare(right.kind);
}

function emitRecipesFile(recipeOperations: ChangeOperation[], generatedAt: string): GeneratedFile {
  const operations = recipeOperations.map(emitRecipeOperation);
  return {
    relativePath: RECIPES_RELATIVE_PATH,
    marker: GENERATED_MARKER,
    content: [
      `// ${GENERATED_MARKER}`,
      '// Do not edit by hand. Regenerate from Delightify-level.',
      `// Generated at: ${generatedAt}`,
      '',
      'ServerEvents.recipes(event => {',
      ...operations,
      '})',
      '',
    ].join('\n'),
  };
}

function emitServerScriptsFile(
  recipeOperations: ChangeOperation[],
  retagOperations: ChangeOperation[],
  generatedAt: string
): GeneratedFile {
  const scaleOperations = recipeOperations.filter(isScaleOperation);
  if (retagOperations.length === 0 && scaleOperations.length === 0) {
    return emitRecipesFile(recipeOperations, generatedAt);
  }

  const lines = [
    `// ${GENERATED_MARKER}`,
    '// Do not edit by hand. Regenerate from Delightify-level.',
    `// Generated at: ${generatedAt}`,
    '',
  ];

  if (recipeOperations.length > 0) {
    const plainRecipeOperations = recipeOperations.filter(operation => !isScaleOperation(operation));
    const sortedScaleOperations = [...scaleOperations].sort(compareScaleOperation);
    const scaleLines = sortedScaleOperations.flatMap(operation => {
      const emitted = emitScaleOperation(operation);
      // 同一配方必须“先 remove 后 custom”，否则 remove 会覆盖重建结果。
      return [emitted.removeLine, emitted.customLine];
    });

    lines.push(
      'ServerEvents.recipes(event => {',
      ...plainRecipeOperations.map(emitRecipeOperation),
      ...scaleLines,
      '})',
      ''
    );
  }

  if (retagOperations.length > 0) {
    lines.push(
      "ServerEvents.tags('item', event => {",
      ...[...retagOperations].sort(compareRetagOperation).map(emitRetagOperation),
      '})',
      ''
    );
  }

  return {
    relativePath: RECIPES_RELATIVE_PATH,
    marker: GENERATED_MARKER,
    content: lines.join('\n'),
  };
}

function renameItemFromOperation(operation: ChangeOperation): string {
  const item = optionalString(operation.before.item) || optionalString(operation.after?.item);
  if (!item) {
    throw new Error(`Change operation ${operation.operationId} 缺少 rename item`);
  }
  return item;
}

function renameLocaleFromOperation(operation: ChangeOperation): string {
  const locale = optionalString(operation.after?.locale) || optionalString(operation.before.locale);
  if (!locale) {
    throw new Error(`Change operation ${operation.operationId} 缺少 rename locale`);
  }
  return locale;
}

function renameNewNameFromOperation(operation: ChangeOperation): string {
  const newName = optionalString(operation.after?.newName);
  if (!newName) {
    throw new Error(`Change operation ${operation.operationId} 缺少 rename newName`);
  }
  return newName;
}

function resourcePart(value: string, label: string): string {
  if (!/^[a-z0-9_.-]+$/.test(value)) {
    throw new Error(`Change operation 生成了非法 ${label}: ${value}`);
  }
  return value;
}

function splitItemId(itemId: string): { namespace: string; path: string } {
  const separatorIndex = itemId.indexOf(':');
  if (separatorIndex <= 0) {
    return { namespace: 'delightify_level', path: itemId };
  }
  return {
    namespace: itemId.slice(0, separatorIndex),
    path: itemId.slice(separatorIndex + 1),
  };
}

function langKeyFromOperation(operation: ChangeOperation): string {
  const explicitKey = optionalString(operation.after?.langKey) ||
    optionalString(operation.before.langKey) ||
    optionalString(operation.before.translationKey);
  if (explicitKey) {
    return explicitKey;
  }

  const item = renameItemFromOperation(operation);
  const { namespace, path: itemPath } = splitItemId(item);
  return `item.${namespace}.${itemPath.replaceAll('/', '.')}`;
}

function langRelativePathFromOperation(operation: ChangeOperation): string {
  const { namespace } = splitItemId(renameItemFromOperation(operation));
  const safeNamespace = resourcePart(namespace, 'namespace');
  const safeLocale = resourcePart(renameLocaleFromOperation(operation), 'locale');
  return `kubejs/assets/${safeNamespace}/lang/${safeLocale}.json`;
}

function compareRenameOperation(left: ChangeOperation, right: ChangeOperation): number {
  const pathDiff = langRelativePathFromOperation(left).localeCompare(langRelativePathFromOperation(right));
  if (pathDiff !== 0) {
    return pathDiff;
  }

  const keyDiff = langKeyFromOperation(left).localeCompare(langKeyFromOperation(right));
  if (keyDiff !== 0) {
    return keyDiff;
  }

  return left.operationId.localeCompare(right.operationId);
}

function emitLangFile(relativePath: string, operations: ChangeOperation[]): GeneratedFile {
  const entries = new Map<string, string>();
  for (const operation of [...operations].sort(compareRenameOperation)) {
    if (!operation.includedInChangeSet) {
      throw new Error(`Change operation ${operation.operationId} 未被纳入 change set`);
    }

    const key = langKeyFromOperation(operation);
    const newName = renameNewNameFromOperation(operation);
    const existing = entries.get(key);
    if (existing !== undefined && existing !== newName) {
      throw new Error(`rename_lang 对 ${key} 生成了冲突的新名称`);
    }
    entries.set(key, newName);
  }

  // TODO: 核实 KubeJS 1.21 对 kubejs/assets/<ns>/lang/*.json 的加载机制；当前按标准资源包 lang json 生成。
  const content = `${JSON.stringify(Object.fromEntries([...entries].sort(([left], [right]) => (
    left.localeCompare(right)
  ))), null, 2)}\n`;

  return {
    relativePath,
    marker: GENERATED_MARKER,
    content,
  };
}

function emitLangFiles(renameOperations: ChangeOperation[]): GeneratedFile[] {
  const grouped = new Map<string, ChangeOperation[]>();

  for (const operation of renameOperations) {
    const relativePath = langRelativePathFromOperation(operation);
    const operations = grouped.get(relativePath) ?? [];
    operations.push(operation);
    grouped.set(relativePath, operations);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, operations]) => emitLangFile(relativePath, operations));
}

export function emitChangeSet(changeSet: ChangeOperation[], generatedAt = new Date().toISOString()): GeneratedFile[] {
  if (changeSet.length === 0) {
    return [];
  }

  const unsupportedOperations = changeSet.filter(operation => (
    !isServerScriptOperation(operation) &&
    !isRenameOperation(operation) &&
    !isHideOperation(operation)
  ));
  if (unsupportedOperations.length > 0) {
    const kinds = Array.from(new Set(unsupportedOperations.map(operation => operation.kind))).join(', ');
    throw new Error(`KubeJS emitter 暂不支持操作类型: ${kinds}`);
  }

  const recipeOperations = changeSet.filter(isRecipeOperation);
  const scaleOperations = changeSet.filter(isScaleOperation);
  const retagOperations = changeSet.filter(isRetagOperation);
  const renameOperations = changeSet.filter(isRenameOperation);
  const hideOperations = changeSet.filter(isHideOperation);
  const serverScriptOperations = [...recipeOperations, ...scaleOperations];
  if (
    serverScriptOperations.length === 0 &&
    retagOperations.length === 0 &&
    renameOperations.length === 0 &&
    hideOperations.length === 0
  ) {
    return [];
  }

  const files: GeneratedFile[] = [];
  if (serverScriptOperations.length > 0 || retagOperations.length > 0) {
    files.push(emitServerScriptsFile(serverScriptOperations, retagOperations, generatedAt));
  }

  if (hideOperations.length > 0) {
    files.push(emitClientScriptsFile(hideOperations, generatedAt));
  }

  files.push(...emitLangFiles(renameOperations));
  return files;
}

export function generateKubeJs(changeSet: ChangeOperation[], generatedAt = new Date().toISOString()): string {
  if (changeSet.length === 0) {
    throw new Error('change set 为空，没有可导出的 KubeJS 操作');
  }

  const files = emitChangeSet(changeSet, generatedAt);
  const recipesFile = files.find(file => file.relativePath === RECIPES_RELATIVE_PATH);
  const firstFile = recipesFile ?? files[0];
  if (!firstFile) {
    throw new Error('change set 没有可导出的 KubeJS 操作');
  }
  return firstFile.content;
}

export function previewKubeJs(
  params: KubeJsExportParams,
  generatedAt = new Date().toISOString()
): KubeJsPreviewResult {
  const files = emitChangeSet(params.changeSet, generatedAt);

  return {
    operationCount: params.changeSet.length,
    generatedAt,
    files: files.map(file => ({
      relativePath: file.relativePath,
      operationCount: fileOperationCount(file.relativePath, params.changeSet),
      content: file.content,
    })),
  };
}

async function readExistingFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function assertGeneratedFileIsOwned(filePath: string, marker: string): Promise<void> {
  const existing = await readExistingFile(filePath);
  if (existing === null) {
    return;
  }

  if (!existing.includes(marker)) {
    throw new Error(`拒绝覆盖非 Delightify-level 生成文件: ${filePath}`);
  }
}

interface GeneratedManifestEntry {
  relativePath: string;
  marker: string;
}

interface GeneratedManifest {
  marker: string;
  generatedAt?: string;
  files: GeneratedManifestEntry[];
}

function fileOperationCount(relativePath: string, changeSet: ChangeOperation[]): number {
  if (relativePath === RECIPES_RELATIVE_PATH) {
    return changeSet.filter(isServerScriptOperation).length;
  }

  if (relativePath === CLIENT_SCRIPTS_RELATIVE_PATH) {
    return changeSet.filter(isHideOperation).length;
  }

  if (relativePath.startsWith('kubejs/assets/') && relativePath.includes('/lang/')) {
    return changeSet.filter(operation => (
      isRenameOperation(operation) && langRelativePathFromOperation(operation) === relativePath
    )).length;
  }

  return 0;
}

function makeManifest(files: GeneratedFile[], generatedAt: string): GeneratedManifest {
  return {
    marker: GENERATED_MARKER,
    generatedAt,
    files: files.map(file => ({
      relativePath: file.relativePath,
      marker: file.marker,
    })),
  };
}

function manifestContent(manifest: GeneratedManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeGeneratedManifest(projectPath: string, files: GeneratedFile[], generatedAt: string): Promise<void> {
  const filePath = generatedManifestPath(projectPath);
  const manifest = makeManifest(files, generatedAt);

  await assertGeneratedFileIsOwned(filePath, GENERATED_MARKER);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, manifestContent(manifest), 'utf8');
}

async function readGeneratedManifest(projectPath: string): Promise<GeneratedManifest | null> {
  const filePath = generatedManifestPath(projectPath);
  const existing = await readExistingFile(filePath);
  if (existing === null) {
    return null;
  }

  if (!existing.includes(GENERATED_MARKER)) {
    throw new Error(`拒绝读取非 Delightify-level 生成清单: ${filePath}`);
  }

  try {
    const parsed = JSON.parse(existing) as Partial<GeneratedManifest>;
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    return {
      marker: typeof parsed.marker === 'string' ? parsed.marker : GENERATED_MARKER,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : undefined,
      files: files
        .filter((entry): entry is GeneratedManifestEntry => (
          typeof entry?.relativePath === 'string' && typeof entry?.marker === 'string'
        )),
    };
  } catch {
    return {
      marker: GENERATED_MARKER,
      files: [],
    };
  }
}

function isAllowedGeneratedRelativePath(relativePath: string): boolean {
  if (relativePath === RECIPES_RELATIVE_PATH) {
    return true;
  }

  return (
    relativePath.startsWith('kubejs/assets/') &&
    relativePath.includes('/lang/') &&
    relativePath.endsWith('.json')
  ) || (
    relativePath === 'kubejs/client_scripts/zzz_delightify_level_generated.js'
  );
}

function canUseManifestOwnership(relativePath: string): boolean {
  return (
    relativePath.startsWith('kubejs/assets/') &&
    relativePath.includes('/lang/') &&
    relativePath.endsWith('.json')
  );
}

async function deleteOwnedFile(
  projectPath: string,
  entry: GeneratedManifestEntry,
  allowManifestOwnership: boolean
): Promise<boolean> {
  if (!isAllowedGeneratedRelativePath(entry.relativePath)) {
    throw new Error(`拒绝删除不在 Delightify-level 生成路径白名单内的文件: ${entry.relativePath}`);
  }

  const filePath = absoluteGeneratedPath(projectPath, entry.relativePath);
  const existing = await readExistingFile(filePath);
  if (existing === null) {
    return false;
  }

  if (!existing.includes(entry.marker) && !(allowManifestOwnership && canUseManifestOwnership(entry.relativePath))) {
    throw new Error(`拒绝删除非 Delightify-level 生成文件: ${filePath}`);
  }

  await fs.unlink(filePath);
  return true;
}

function isManifestListed(manifest: GeneratedManifest | null, relativePath: string): boolean {
  return Boolean(manifest?.files.some(file => file.relativePath === relativePath));
}

async function assertGeneratedFileCanBeWritten(
  projectPath: string,
  file: GeneratedFile,
  manifest: GeneratedManifest | null
): Promise<void> {
  if (!isAllowedGeneratedRelativePath(file.relativePath)) {
    throw new Error(`拒绝写入不在 Delightify-level 生成路径白名单内的文件: ${file.relativePath}`);
  }

  const filePath = absoluteGeneratedPath(projectPath, file.relativePath);
  const existing = await readExistingFile(filePath);
  if (existing === null || existing.includes(file.marker)) {
    return;
  }

  if (isManifestListed(manifest, file.relativePath) && canUseManifestOwnership(file.relativePath)) {
    return;
  }

  throw new Error(`拒绝覆盖非 Delightify-level 生成文件: ${filePath}`);
}

async function deleteOrphanGeneratedFiles(
  projectPath: string,
  manifest: GeneratedManifest | null,
  files: GeneratedFile[]
): Promise<void> {
  if (!manifest) {
    return;
  }

  const nextRelativePaths = new Set(files.map(file => file.relativePath));
  const orphanEntries = manifest.files
    .filter(entry => !nextRelativePaths.has(entry.relativePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  for (const entry of orphanEntries) {
    await deleteOwnedFile(projectPath, entry, true);
  }
}

async function deleteGeneratedManifest(projectPath: string): Promise<void> {
  const manifestPath = generatedManifestPath(projectPath);
  const manifestContentText = await readExistingFile(manifestPath);
  if (manifestContentText === null) {
    return;
  }

  if (!manifestContentText.includes(GENERATED_MARKER)) {
    throw new Error(`拒绝删除非 Delightify-level 生成清单: ${manifestPath}`);
  }

  await fs.unlink(manifestPath);
}

export async function exportKubeJs(
  projectPath: string,
  params: KubeJsExportParams,
  options: KubeJsExportOptions = {}
): Promise<KubeJsExportResult> {
  const filePath = generatedFilePath(projectPath);
  const writtenAt = options.generatedAt ?? new Date().toISOString();
  const files = emitChangeSet(params.changeSet, writtenAt);
  const recipesFile = files.find(file => file.relativePath === RECIPES_RELATIVE_PATH);
  const manifest = await readGeneratedManifest(projectPath);

  for (const file of files) {
    await assertGeneratedFileCanBeWritten(projectPath, file, manifest);
  }

  if (files.length > 0) {
    await assertGeneratedFileIsOwned(generatedManifestPath(projectPath), GENERATED_MARKER);
  }

  await deleteOrphanGeneratedFiles(projectPath, manifest, files);

  for (const file of files) {
    const targetPath = absoluteGeneratedPath(projectPath, file.relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, 'utf8');
  }

  if (files.length > 0) {
    await writeGeneratedManifest(projectPath, files, writtenAt);
  } else {
    await deleteGeneratedManifest(projectPath);
  }

  return {
    filePath,
    operationCount: params.changeSet.length,
    generatedCode: recipesFile?.content ?? '',
    writtenAt,
    files: files.map(file => ({
      filePath: absoluteGeneratedPath(projectPath, file.relativePath),
      operationCount: fileOperationCount(file.relativePath, params.changeSet),
    })),
  };
}

export async function revertKubeJs(projectPath: string): Promise<KubeJsRevertResult> {
  const filePath = generatedFilePath(projectPath);
  const manifest = await readGeneratedManifest(projectPath);
  const entries = new Map<string, GeneratedManifestEntry>();

  entries.set(RECIPES_RELATIVE_PATH, {
    relativePath: RECIPES_RELATIVE_PATH,
    marker: GENERATED_MARKER,
  });

  for (const entry of manifest?.files ?? []) {
    entries.set(entry.relativePath, entry);
  }

  let deleted = false;
  for (const entry of entries.values()) {
    const isManifestListed = Boolean(manifest?.files.some(file => file.relativePath === entry.relativePath));
    const didDelete = await deleteOwnedFile(projectPath, entry, isManifestListed);
    deleted = deleted || didDelete;
  }

  const manifestPath = generatedManifestPath(projectPath);
  const manifestContentText = await readExistingFile(manifestPath);
  if (manifestContentText !== null) {
    if (!manifestContentText.includes(GENERATED_MARKER)) {
      throw new Error(`拒绝删除非 Delightify-level 生成清单: ${manifestPath}`);
    }
    await fs.unlink(manifestPath);
    deleted = true;
  }

  return { filePath, deleted };
}
