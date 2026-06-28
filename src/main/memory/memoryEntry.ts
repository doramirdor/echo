export interface MemoryEntry {
  id: string;
  term: string;
  context: string;
  misrecognitions: string[];
  category: 'productName' | 'personName' | 'technicalTerm' | 'acronym' | 'custom';
  useCount: number;
  createdAt: string;
  updatedAt: string;
}
