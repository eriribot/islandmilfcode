import type { MusicPlayerState, MusicSearchState, MusicSource, MusicTrack, PhoneCharacterId } from './types';

const API_BASE = 'https://music-api.gdstudio.xyz/api.php';

// 音源选项的展示顺序与文案。下拉/分段控件直接渲染这份。
export const MUSIC_SOURCE_OPTIONS: Array<{ value: MusicSource; label: string }> = [
  { value: 'netease', label: '网易云' },
  { value: 'tencent', label: 'QQ 音乐' },
  { value: 'kuwo', label: '酷我' },
  { value: 'kugou', label: '酷狗' },
  { value: 'migu', label: '咪咕' },
  { value: 'joox', label: 'JOOX' },
  { value: 'ytmusic', label: 'YT Music' },
];

const DEFAULT_SOURCE: MusicSource = 'netease';

export function createDefaultMusicSearchState(): MusicSearchState {
  return {
    query: '',
    source: DEFAULT_SOURCE,
    status: 'idle',
    results: [],
    error: null,
    requestId: 0,
  };
}

export function createDefaultMusicPlayerState(): MusicPlayerState {
  return {
    currentTrack: null,
    queue: [],
    playing: false,
    loadingTrackId: null,
    currentTime: 0,
    duration: 0,
    search: createDefaultMusicSearchState(),
  };
}

// 五小只默认歌单：女主头像点击仍走原有 BGM；这里给搜索页提供一个推荐入口，
// 点一下就把网易云上对应的角色歌作为搜索结果填进去。关键词随便改。
export const CHARACTER_QUICK_SEARCH: Record<PhoneCharacterId, string> = {
  megumi: '冴えない彼女の育てかた',
  eriri: '澤村·斯賓塞·英梨梨',
  utaha: '霞ヶ丘詩羽',
  izumi: '波島出海',
  michiru: '氷堂美智留',
};

// 角色 BGM 在 hero 卡上的展示元数据。展示用名字与艺人保持作品内观感，封面复用头像。
export const CHARACTER_BGM_META: Record<
  PhoneCharacterId,
  { name: string; artist: string; album: string; picUrl: string }
> = {
  megumi: {
    name: '加藤恵 主题曲',
    artist: '加藤惠',
    album: '不起眼女主角培育法 OST',
    picUrl: 'https://eriribot.github.io/islandmilfcode/picresource/megumi_phone.jpg',
  },
  eriri: {
    name: '澤村·斯賓塞·英梨梨 主题曲',
    artist: '英梨梨',
    album: '不起眼女主角培育法 OST',
    picUrl: 'https://eriribot.github.io/islandmilfcode/picresource/eriri_phone.jpg',
  },
  utaha: {
    name: '霞ヶ丘詩羽 主题曲',
    artist: '霞之丘诗羽',
    album: '不起眼女主角培育法 OST',
    picUrl: 'https://eriribot.github.io/islandmilfcode/picresource/utaha_phone.jpg',
  },
  izumi: {
    name: '波島出海 主题曲',
    artist: '波岛出海',
    album: '不起眼女主角培育法 OST',
    picUrl: 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg',
  },
  michiru: {
    name: '氷堂美智留 主题曲',
    artist: '美智留',
    album: '不起眼女主角培育法 OST',
    picUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Michiru_phone.jpg',
  },
};

export function makeCharacterBgmTrack(characterId: PhoneCharacterId, bgmUrl: string): MusicTrack {
  const meta = CHARACTER_BGM_META[characterId];
  return {
    id: `bgm:${characterId}`,
    kind: 'bgm',
    source: 'netease',
    name: meta.name,
    artist: meta.artist,
    album: meta.album,
    picId: '',
    lyricId: '',
    picUrl: meta.picUrl,
    streamUrl: bgmUrl,
  };
}

type GdStudioSearchItem = {
  id?: number | string;
  name?: string;
  artist?: string[] | string;
  album?: string;
  pic_id?: string;
  url_id?: string;
  lyric_id?: string;
  source?: string;
};

function joinArtists(artist: GdStudioSearchItem['artist']): string {
  if (Array.isArray(artist)) return artist.filter(Boolean).join(' / ');
  return typeof artist === 'string' ? artist : '';
}

function normalizeTrack(item: GdStudioSearchItem, fallbackSource: MusicSource): MusicTrack | null {
  const id = item.url_id ?? item.id;
  if (id === undefined || id === null) return null;
  const source = (item.source as MusicSource) || fallbackSource;
  return {
    id: String(id),
    kind: 'search',
    source,
    name: String(item.name ?? '').trim() || '未知曲目',
    artist: joinArtists(item.artist) || '未知艺人',
    album: String(item.album ?? '').trim(),
    picId: String(item.pic_id ?? ''),
    lyricId: String(item.lyric_id ?? id),
  };
}

export async function searchMusic(query: string, source: MusicSource, count = 20): Promise<MusicTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `${API_BASE}?types=search&source=${encodeURIComponent(source)}&name=${encodeURIComponent(trimmed)}&count=${count}&pages=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`搜索失败：${response.status}`);
  const data = (await response.json()) as GdStudioSearchItem[] | { data?: GdStudioSearchItem[] };
  const list = Array.isArray(data) ? data : Array.isArray((data as any)?.data) ? (data as any).data : [];
  return list
    .map((item: GdStudioSearchItem) => normalizeTrack(item, source))
    .filter((track: MusicTrack | null): track is MusicTrack => Boolean(track));
}

type GdStudioUrlResponse = { url?: string; br?: number; size?: number };

export async function fetchTrackStreamUrl(track: MusicTrack, br: 128 | 192 | 320 | 740 | 999 = 320): Promise<string> {
  const url = `${API_BASE}?types=url&source=${encodeURIComponent(track.source)}&id=${encodeURIComponent(track.id)}&br=${br}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`获取音频地址失败：${response.status}`);
  const data = (await response.json()) as GdStudioUrlResponse;
  const streamUrl = String(data?.url ?? '').trim();
  if (!streamUrl) throw new Error('音频地址为空，可能版权受限');
  return streamUrl;
}

export async function fetchTrackPicUrl(track: MusicTrack, size: 300 | 500 | 800 = 300): Promise<string> {
  if (!track.picId) return '';
  const url = `${API_BASE}?types=pic&source=${encodeURIComponent(track.source)}&id=${encodeURIComponent(track.picId)}&size=${size}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    const data = (await response.json()) as { url?: string };
    return String(data?.url ?? '').trim();
  } catch {
    return '';
  }
}

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
