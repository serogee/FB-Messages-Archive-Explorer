import { bench, describe } from 'vitest';
import { calculateGalleryLayout, type GalleryGroup } from '../../src/components/AttachmentGallery/galleryLayout';

const groups: GalleryGroup[] = Array.from({ length: 120 }, (_, month) => ({
  key: String(month),
  label: `Month ${month}`,
  items: Array.from({ length: 75 }, (_, index) => ({
    mediaPath: `media/${month}-${index}.jpg`,
    category: 'photos',
    messageIndex: month * 75 + index,
    timestamp: month,
    sender: 'Benchmark',
    mediaEntry: null,
  })),
}));

describe('attachment gallery performance', () => {
  bench('calculate virtual rows for 9k attachments', () => {
    calculateGalleryLayout(groups, 680);
  }, { time: 500, warmupTime: 100 });
});
