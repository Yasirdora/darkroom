export interface SampleImage {
  id: string;
  label: string;
  title: string;
  src: string;
}

export const SAMPLE_IMAGES: SampleImage[] = [
  {
    id: 'misty_valley',
    label: 'Misty Valley',
    title: 'Misty valley landscape',
    src: '/images/samples/misty_valley.jpg',
  },
  {
    id: 'woman_freckles',
    label: 'Portrait',
    title: 'Portrait with freckles',
    src: '/images/samples/woman_freckles.jpg',
  },
  {
    id: 'family_mountains',
    label: 'Mountains',
    title: 'Family in the mountains',
    src: '/images/samples/family_mountains.jpg',
  },
];