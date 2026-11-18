// Louvain lives in @synaipse/core (shared with the server layout); this
// module only adds the community colour palette.
export {detectCommunities, type CommunityResult} from '@synaipse/core/louvain';

const PALETTE = [
    '#6c9aff', '#34d399', '#fbbf24', '#f472b6', '#a78bfa',
    '#fb923c', '#22d3ee', '#84cc16', '#f87171', '#e879f9',
    '#60a5fa', '#fcd34d', '#4ade80', '#fb7185', '#c084fc'
];

export const communityColor = (communityId: number): string => {
    const idx = ((communityId % PALETTE.length) + PALETTE.length) % PALETTE.length;
    return PALETTE[idx] as string;
};