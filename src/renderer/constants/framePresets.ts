export interface FramePreset {
  name: string;
  width: number;
  height: number;
}

export interface PresetCategory {
  label: string;
  presets: FramePreset[];
}

export const FRAME_PRESETS: PresetCategory[] = [
  {
    label: 'Phone',
    presets: [
      { name: 'iPhone 17',              width: 402,  height: 874  },
      { name: 'iPhone 16 & 17 Pro',     width: 402,  height: 874  },
      { name: 'iPhone 16',              width: 393,  height: 852  },
      { name: 'iPhone 16 & 17 Pro Max', width: 440,  height: 956  },
      { name: 'iPhone 16 Plus',         width: 430,  height: 932  },
      { name: 'iPhone Air',             width: 420,  height: 912  },
      { name: 'iPhone 14 & 15 Pro Max', width: 430,  height: 932  },
      { name: 'iPhone 14 & 15 Pro',     width: 393,  height: 852  },
      { name: 'iPhone 13 & 14',         width: 390,  height: 844  },
      { name: 'iPhone 14 Plus',         width: 428,  height: 926  },
      { name: 'Android Compact',        width: 412,  height: 917  },
      { name: 'Android Medium',         width: 700,  height: 840  },
    ],
  },
  {
    label: 'Tablet',
    presets: [
      { name: 'iPad mini',     width: 744,  height: 1133 },
      { name: 'iPad',          width: 820,  height: 1180 },
      { name: 'iPad Pro 11"',  width: 834,  height: 1194 },
      { name: 'iPad Pro 13"',  width: 1032, height: 1366 },
    ],
  },
  {
    label: 'Desktop',
    presets: [
      { name: 'MacBook Air',      width: 1280, height: 832  },
      { name: 'MacBook Pro 14"',  width: 1512, height: 982  },
      { name: 'MacBook Pro 16"',  width: 1728, height: 1117 },
      { name: 'Desktop',          width: 1440, height: 1024 },
      { name: 'iMac',             width: 1280, height: 720  },
    ],
  },
  {
    label: 'Presentation',
    presets: [
      { name: 'Slide 16:9', width: 1920, height: 1080 },
      { name: 'Slide 4:3',  width: 1024, height: 768  },
    ],
  },
  {
    label: 'Watch',
    presets: [
      { name: 'Apple Watch Ultra 2', width: 410, height: 502 },
      { name: 'Apple Watch 45mm',    width: 396, height: 484 },
      { name: 'Apple Watch 41mm',    width: 352, height: 430 },
    ],
  },
  {
    label: 'Paper',
    presets: [
      { name: 'A4',      width: 595,  height: 842  },
      { name: 'A3',      width: 842,  height: 1191 },
      { name: 'Letter',  width: 816,  height: 1056 },
      { name: 'Tabloid', width: 1056, height: 1632 },
    ],
  },
  {
    label: 'Social Media',
    presets: [
      { name: 'Instagram Post',    width: 1080, height: 1080 },
      { name: 'Instagram Story',   width: 1080, height: 1920 },
      { name: 'X / Twitter Post',  width: 1600, height: 900  },
      { name: 'Facebook Post',     width: 1200, height: 630  },
      { name: 'LinkedIn Post',     width: 1200, height: 627  },
      { name: 'YouTube Thumbnail', width: 1280, height: 720  },
    ],
  },
];
