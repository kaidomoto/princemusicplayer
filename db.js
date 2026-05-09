const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const playlistsFile = path.join(dataDir, 'playlists.json');
const songsFile = path.join(dataDir, 'songs.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const loadData = () => {
    try {
        const playlists = JSON.parse(fs.readFileSync(playlistsFile));
        const songs = JSON.parse(fs.readFileSync(songsFile));
        return { playlists, songs };
    } catch (e) {
        return { playlists: [], songs: [] };
    }
};

const saveData = (playlists, songs) => {
    if (playlists) fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2));
    if (songs) fs.writeFileSync(songsFile, JSON.stringify(songs, null, 2));
};

module.exports = { loadData, saveData };
