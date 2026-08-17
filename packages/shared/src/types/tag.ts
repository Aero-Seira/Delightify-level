/**
 * Tag type definitions
 */

export interface Tag {
  tagId: string;
  modId: string;
  tagType: 'item' | 'block' | 'fluid' | 'entity';
  itemCount?: number;
}
