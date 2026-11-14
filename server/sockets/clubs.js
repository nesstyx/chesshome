// sockets/clubs.js — комнаты клубных чатов

const {
  clubs,
  isClubModerator,
  canWriteInClubChat,
} = require('../core');

module.exports = function registerClubs(socket) {
  socket.on('join_club_room', (clubId) => {
    if (!socket.username) return;
    const club = clubs.find(c => c.id === clubId);
    if (!club) return;
    if (!canWriteInClubChat(club, socket.username) && !isClubModerator(club, socket.username)) return;
    socket.join('club_' + clubId);
  });

  socket.on('leave_club_room', (clubId) => { socket.leave('club_' + clubId); });
}
