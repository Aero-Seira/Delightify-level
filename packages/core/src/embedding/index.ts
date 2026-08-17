export { buildSourceText, type ItemTextFacts } from './text';
export {
  buildEmbeddings,
  vectorToBlob,
  blobToVector,
  type EmbedFn,
  type BuildEmbeddingsResult,
} from './build';
export {
  searchByVector,
  searchByText,
  searchSimilarItems,
  type EmbeddingSearchHit,
  type EmbeddingSearchResult,
} from './search';
