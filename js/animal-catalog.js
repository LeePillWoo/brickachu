export const ANIMAL_NAMES = {
    dog: '강아지', cat: '고양이', rabbit: '토끼', sheep: '양', pig: '돼지', horse: '말',
    elephant: '코끼리', giraffe: '기린', lion: '사자', bear: '곰', kangaroo: '캥거루', panda: '판다',
    otter: '수달', penguin: '펭귄', turtle: '거북이', frog: '개구리', crocodile: '악어', octopus: '문어', crab: '꽃게',
    snake: '뱀', grasshopper: '메뚜기', snail: '달팽이', lizard: '도마뱀', hedgehog: '고슴도치',
    pikachu: '피카츄', squirtle: '꼬부기', charmander: '파이리', meowth: '나옹', snorlax: '잠만보',
    jigglypuff: '푸린', diglett: '디그다', porygon: '폴리곤', ditto: '메타몽', eevee: '이브이',
    gengar: '팬텀', psyduck: '고라파덕', bulbasaur: '이상해씨', slowpoke: '야돈', togepi: '토게피',
    clefairy: '삐삐', wobbuffet: '마자용', vulpix: '식스테일', marill: '마릴', 'baby-dragon': '아기 용'
};

// Browsing categories are independent of walking, jumping and obstacle abilities.
export const ANIMAL_CATEGORIES = [
    { id: 'pets', icon: '🐶', label: '동네 친구', description: '함께 놀기 좋아하는 친근한 친구들', types: ['dog', 'cat', 'rabbit', 'sheep', 'pig', 'horse'] },
    { id: 'forest', icon: '🌳', label: '숲·초원', description: '숲과 초원을 누비는 친구들', types: ['elephant', 'giraffe', 'lion', 'bear', 'kangaroo', 'panda'] },
    { id: 'water', icon: '💧', label: '물가 친구', description: '물놀이를 좋아하는 친구들', types: ['otter', 'penguin', 'turtle', 'frog', 'crocodile', 'octopus', 'crab'] },
    { id: 'tiny', icon: '🌱', label: '작은 친구', description: '풀숲에서 만나는 작은 친구들', types: ['snake', 'grasshopper', 'snail', 'lizard', 'hedgehog'] },
    { id: 'magic', icon: '✨', label: '상상 친구', description: '신기한 재주를 가진 상상 속 친구들', types: ['pikachu', 'squirtle', 'charmander', 'meowth', 'snorlax', 'jigglypuff', 'diglett', 'porygon', 'ditto', 'eevee', 'gengar', 'psyduck', 'bulbasaur', 'slowpoke', 'togepi', 'clefairy', 'wobbuffet', 'vulpix', 'marill', 'baby-dragon'] }
];
ANIMAL_CATEGORIES.unshift({ id: 'all', icon: '🐾', label: '전체', description: '모든 친구 중에서 만나기', types: ANIMAL_CATEGORIES.flatMap(category => category.types) });
