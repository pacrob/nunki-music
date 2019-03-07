// Paul Robinson, Soo Lee, Michael Truong
// CS467 - Capstone - Winter 2019
// Nunki Music App


const express = require('express');
const bodyParser = require('body-parser');
const app = express();

const format = require('util').format;
const Multer = require('multer'); // multer is used for file uploads
const process = require('process');
const path = require('path');
const cors = require('cors');

const getMP3Duration = require('get-mp3-duration'); // get length of mp3 in ms

const fs = require('fs');
const http = require('http');

app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());

const {Datastore} = require('@google-cloud/datastore');
const {Storage} = require('@google-cloud/storage');

// defines max file size for upload
const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 5 * 2048 * 2048 // no larger than 20mb, change as needed
  }
});




// creat a datastore client
const datastore = new Datastore();
// create a storage client 
const storage = new Storage();

// used to get all info about an entity
function fromDatastore(item){
    item.id = item[Datastore.KEY].id;
    return item;
}

// name the buckets we're using
const imageBucketName = 'album-images-nunki-music';
const imageBucket = storage.bucket(imageBucketName);
const songBucketName = 'song-files-nunki-music';
const songBucket = storage.bucket(songBucketName);

// the base url for the server
const BASEURL = "https://nunki-music.appspot.com";

// needed for preflight check
app.options('/playlists', cors());
app.options('/playlists/:playlistId', cors());
app.options('/songs', cors());
app.options('/songs/:songId', cors());


//***************************************************************************
// START Post a Song
//***************************************************************************

/* takes a song object and saves it to the Datastore */

function postSong(song) {
  const key = datastore.key('song');
  return datastore.save({"key": key, "data": song})
  .then(() => {return key})
  // get the key back from the first save, use it in the self link and resave
  .then ( (result) => {
    song.self = (BASEURL + "/songs/" + key.id);
    return datastore.save({"key": key, "data": song})
  }).then(() => {return key});
}

/* takes a bucket name and a file object, saves it to a bucket
   returns the public url to access it in the bucket */

function saveFileToBucket(bucket, newFile){
  const blob = bucket.file(newFile.originalname);
  const blobStream = blob.createWriteStream({
    resumable: false
  });

  return new Promise(function(resolve, reject) {

    blobStream.on('error', (err)=>{
      console.log(err.message);
      next(err);
    });

    blobStream.on('finish', ()=>{
      const publicUrl = format(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
      resolve(publicUrl);
    });

    blobStream.end(newFile.buffer);
  });
}

/* takes a bucket name and a filename, makes the file publicly accessible */

async function makePublic(bucketName, filename) {
  await storage
    .bucket(bucketName)
    .file(filename)
    .makePublic();
}

/* POST method 
   Takes name, artist, order, and album as text fields, source and artwork
   as files in request body. Order is the order the song appears on the album
   Saves files to bucket and song object to datastore
   returns a song object that contains:
   name, artist, album, duration(ms), source url, artwork url,
   self url (in datastore), and datastore id number

   -makePublic step makes file publicly accessible-
*/

app.post('/songs', multer.fields([{ name: 'artwork', maxCount: 1},
                                  { name: 'source', maxCount: 1}]),
                                (req, res) => {

  var song = {"name": req.body.name, 
              "artist": req.body.artist,
              "order": parseInt(req.body.order),
              "album": req.body.album};

                                  
  song.duration = getMP3Duration(req.files.source[0].buffer);
    
  return saveFileToBucket(songBucket, req.files.source[0]).then((url)=>{
    song.source = url;
    return;
  }).then(() => {
    return makePublic(songBucketName, req.files.source[0].originalname)
  }).then(() => {
    return saveFileToBucket(imageBucket, req.files.artwork[0])
  }).then((url2)=>{
    song.artwork = url2;
    return;
  }).then(() => {
    return makePublic(imageBucketName, req.files.artwork[0].originalname)
  }).then(() => {
    return postSong(song);
  }).then(result => {
    song.id = result.id;
    res
      .status(201)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", 
              "Origin, X-Requested-With, Content-Type, Accept")
      .json(song)
      .end();
  }).catch( (err) => {
    console.log("post Song error caught");
    res
      .status(500)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", 
              "Origin, X-Requested-With, Content-Type, Accept")
      .send('500 - Unknown Post Song Error')
      .end()
  });
});
// END Upload a Song
//***************************************************************************


//***************************************************************************
// START Get song by Id
//***************************************************************************

async function songSearch(songId) {
  const songKey = datastore.key(['song', parseInt(songId,10)]);
  const query = datastore.createQuery('song').filter('__key__', '=', songKey);
  return datastore.runQuery(query);
}

async function validateSong(songId) {
  const songKey = datastore.key(['song', parseInt(songId,10)]);
  return songSearch(songId).then (results => {
    if (results[0].length > 0) {
      console.log("songSearch results len > 0");
      const query = datastore.createQuery('song').filter('__key__', '=', songKey);
      return datastore.runQuery(query);
    }
    else {
      console.log("songSearch results len not > 0");
      var e = new Error;
      e.name = 'InvalidSongIdError';
      throw e;
    };
  });
}
// returns a single song 
function getSongById(songId) {
  return validateSong(songId).then((entities) => {
    return entities[0].map(fromDatastore);
  }).catch((error) => {
    console.log("error in getSongById");
    console.log(error);
    throw error;
  });
}

// get a single song by its Id
app.get('/songs/:songId', (req, res) => {
  const song = getSongById(req.params.songId)
    .then((song) => {
      res
        .status(200)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", 
                "Origin, X-Requested-With, Content-Type, Accept")
        .json(song);
    }).catch(function(error) {
      if (error.name == 'InvalidSongIdError') {
        res
          .status(404)
          .send({error:"404 - No song found with this Id"});
      }
      else {
        console.log(error);
        res
          .status(500)
          .send({error:"500 - Unknown Get Song By Id Error"});
      }
    });
});


// END Get song by Id
//***************************************************************************

//***************************************************************************
// START List all songs
//***************************************************************************

function getSongs(req) {
  // first query to get song info to displey
  var q = datastore.createQuery('song');
  const results = {};
  return datastore.runQuery(q).then ( (entities) => {
    results.items = entities[0].map(fromDatastore);
    return entities;
  }).then( (entities) => {
    results.totalSearchResults = entities[0].length;
    console.log(entities);
    return results;
  });
}

app.get('/songs', (req, res) => {
  const songs = getSongs(req)
    .then((songs) => {
        console.log(songs);
        res
          .status(200)
          .header("Access-Control-Allow-Origin", "*")
          .header("Access-Control-Allow-Headers", 
                  "Origin, X-Requested-With, Content-Type, Accept")
          .json(songs);
    });
});

// END List all songs
//***************************************************************************

//***************************************************************************
// START Delete song by id
//***************************************************************************


// END Delete song by id
//***************************************************************************

//***************************************************************************
// START Post new playlist
//***************************************************************************

// takes: playlist json object with name
//
// returns: a playlist key with the newly assigned id
function postPlaylist(playlist) {
  const key = datastore.key('playlist');
  return datastore.save({"key": key, "data": playlist})
  .then(() => {return key})
  // get the key back from the first save, use it in the self link and resave
  .then ( (result) => {



    playlist.self = (BASEURL + "/playlists/" + key.id);
    playlist.songs = [];
    return datastore.save({"key": key, "data": playlist})
  }).then(() => {return key});
    
}

// 'name' needs to be sent in the body as x-www-form-urlencoded
// format in Postman, at least. Doesn't show up if form-data, unlike songs

app.post('/playlists', (req, res) => {

  var playlist = {"name": req.body.name};
  console.log("post list hit, name is " + req.body.name);

  return postPlaylist(playlist).then(result => {
    playlist.id = result.id;
    res
      .status(201)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", 
              "Origin, X-Requested-With, Content-Type, Accept")
      .json(playlist)
      .end();
  }).catch( (err) => {
    res
      .status(500)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", 
              "Origin, X-Requested-With, Content-Type, Accept")
      .send('500 - Unknown post playlist error')
      .end()
  });
});

// END Post new playlist
//***************************************************************************


//***************************************************************************
// START Get Playlist by Id
//***************************************************************************

async function playlistSearch(playlistId) {
  const playlistKey = datastore.key(['playlist', parseInt(playlistId,10)]);
  const query = datastore.createQuery('playlist').filter('__key__', '=', playlistKey);
  return datastore.runQuery(query);
}

async function validatePlaylist(playlistId) {
  const playlistKey = datastore.key(['playlist', parseInt(playlistId,10)]);
  return playlistSearch(playlistId).then (results => {
    if (results[0].length > 0) {
      console.log("playlistSearch results len > 0");
      const query = datastore.createQuery('playlist').filter('__key__', '=', playlistKey);
      return datastore.runQuery(query);
    }
    else {
      console.log("playlistSearch results len not > 0");
      var e = new Error;
      e.name = 'InvalidPlaylistIdError';
      throw e;
    };
  });
}


// returns a single playlist
function getPlaylistById(playlistId) {
  return validatePlaylist(playlistId).then((entities) => {
    return entities[0].map(fromDatastore);
  }).catch((error) => {
    console.log("error in getPlaylistById");
    console.log(error);
    throw error;
  });
}

// get a single playlist by its Id
app.get('/playlists/:playlistId', (req, res) => {
  const playlist = getPlaylistById(req.params.playlistId)
    .then((playlist) => {
      res
        .status(200)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", 
                "Origin, X-Requested-With, Content-Type, Accept")
        .json(playlist);
    }).catch(function(error) {
      if (error.name == 'InvalidPlaylistIdError') {
        res
          .status(404)
          .send({error:"404 - No playlist found with this Id"});
      }
      else {
        console.log(error);
        res
          .status(500)
          .send({error:"500 - Unknown Get Playlist By Id Error"});
      }
    });
});
// END Get Playlist by Id
//***************************************************************************

//***************************************************************************
// START List all playlists
//***************************************************************************

function getPlaylists(req) {
  // first query to get playlists info to display
  var q = datastore.createQuery('playlist');
  const results = {};
  return datastore.runQuery(q).then ( (entities) => {
    results.items = entities[0].map(fromDatastore);
    return entities;
  }).then( (entities) => {
    results.totalSearchResults = entities[0].length;
    //console.log(entities);
    return results;
  });
}

app.get('/playlists', (req, res) => {
  const playlists = getPlaylists(req)
    .then((playlists) => {
        //console.log(playlists);
        res
          .status(200)
          .header("Access-Control-Allow-Origin", "*")
          .header("Access-Control-Allow-Headers", 
                  "Origin, X-Requested-With, Content-Type, Accept")
          .json(playlists);
    });
});

// END List all playlists 
//***************************************************************************
//***************************************************************************
// START Delete playlist by id
//***************************************************************************

function deletePlaylist(playlistId){
  const playlistKey = datastore.key(['playlist', parseInt(playlistId,10)]);
  return validatePlaylist(playlistId).then((results) => {
    return datastore.delete(playlistKey);
  }).catch(function(error) {
    if (error.name == 'InvalidPlaylistIdError') {
      throw error;
    }
    else {
      console.log(error);
      throw error;
    }
  });
}
app.delete('/playlists/:playlistId', (req, res) => {
  return deletePlaylist(req.params.playlistId)
  .then((result) => {
      res
        .status(204)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", 
                "Origin, X-Requested-With, Content-Type, Accept")
        .end();
    }).catch(function(error) {
      if (error.name == 'InvalidPlaylistIdError') {
        res
          .status(404)
          .send({error:"404 - No playlist found with this Id"});
      }
      else {
        console.log(error);
        res
          .status(500)
          .send({error:"500 - Unknown Delete Playlist By Id Error"});
      }
    });
});

// END Delete playlist by id
//***************************************************************************
//***************************************************************************
// START add and remove songs from playlists
//***************************************************************************
function addSongToPlaylist(songId, playlistId, songOrder) {
  const playlistKey = datastore.key(['playlist', parseInt(playlistId,10)]);
  songObj = {};

  return validateSong(songId).then((results) => {
    //songObj.self = results[0][0].self;
    songObj.order = parseInt(songOrder);
    songObj.songId = songId;
    songObj.songInfo = results[0][0];
    return validatePlaylist(playlistId);
  }).then((results) => {
    var playlistToAppendTo = results[0][0];

    playlistToAppendTo.songs.push(songObj);
    console.log("this is playlistToAppendTo after push");
    console.log(playlistToAppendTo);
    return datastore.update({"key": playlistKey, "data": playlistToAppendTo});
  }).catch(function(error) {
    if (error.name == 'InvalidPlaylistIdError') {
      throw error;
    }
    else if (error.name == 'InvalidSongIdError') {
      throw error;
    }
    else {
      var e = new Error;
      e.name = 'UnknownAddSongToPlaylistError';
      throw e;
    }
  });
}
function isSongInPlaylist(songId, playlistId) {
  const playlistKey = datastore.key(['playlist', parseInt(playlistId,10)]);

  return validateSong(songId).then(() => {
    return validatePlaylist(playlistId);
  }).then((results) => {
    var songPlaylistArray = results[0][0].songs;
    for (var i = 0; i < songPlaylistArray.length; ++i){
      if (songPlaylistArray[i].songId == songId) {
        return true;
      }
    }
    return false;
  });
}
function deleteSongFromPlaylist(songId, playlistId) {
  const playlistKey = datastore.key(['playlist', parseInt(playlistId,10)]);

  return validateSong(songId).then(() => {
    return validatePlaylist(playlistId);
  }).then((results) => {
    //make a copy of the retrieved playlist
    var songPlaylistObj = results[0][0];
    //filter a copy of its song playlist minus the song to delete
    var songPlaylistArray = results[0][0].songs.filter(function(el)
                                                    {return el.songId != songId;});
    songPlaylistObj.songs = songPlaylistArray;

    return datastore.update({"key": playlistKey, "data": songPlaylistObj});
  }).catch(function(error) {
    if (error.name == 'InvalidPlaylistIdError') {
      throw error;
    }
    else if (error.name == 'InvalidSongIdError') {
      throw error;
    }
    else {
      var e = new Error;
      e.name = 'UnknownDeleteSongFromPlaylistError';
      throw e;
    }
  });
}
// Add a song to a playlist
app.put('/playlists/:playlistId/songs/:songId', (req, res) => {
    return isSongInPlaylist(req.params.songId, req.params.playlistId)
  .then((result) => {
    console.log("this is result of isSongInPlaylist");
    console.log(result);
    if (result == true) {
      var e = new Error;
      e.name = 'SongAlreadyInPlaylistError';
      throw e;
    }
  }).then(() => {

    return addSongToPlaylist(req.params.songId, req.params.playlistId, req.body.order);
  }).then(() => {
      res
        .status(200)
        .send("200 - Song added to Playlist");
    }).catch(function(error) {
      if (error.name == 'InvalidSongIdError') {
        res
          .status(404)
          .send({error:"404 - No song found with this Id"});
      }
      else if (error.name == 'InvalidPlaylistIdError') {
        res
          .status(404)
          .send({error:"404 - No playlist found with this Id"});
      }
      else if (error.name == 'SongAlreadyInPlaylistError') {
        res
          .status(409)
          .send({error:"409 - Song already in playlist"});
      }
      else {
        res
          .status(500)
          .send({error:"500 - Unknown Add Song to Playlist Error"});
      }
    });
});

// delete a song from a playlist
app.delete('/playlists/:playlistId/songs/:songId', (req, res) => {
    return isSongInPlaylist(req.params.songId, req.params.playlistId)
  .then((result) => {
    console.log("this is result of isSongInPlaylist");
    console.log(result);
    if (result == false) {
      var e = new Error;
      e.name = 'SongNotInPlaylistError';
      throw e;
    }
  }).then(() => {

    return deleteSongFromPlaylist(req.params.songId, req.params.playlistId);
  }).then(() => {
      res
        .status(204)
        .send("204- Song deleted from Playlist");
    }).catch(function(error) {
      if (error.name == 'InvalidSongIdError') {
        res
          .status(404)
          .send({error:"404 - No song found with this Id"});
      }
      else if (error.name == 'InvalidPlaylistIdError') {
        res
          .status(404)
          .send({error:"404 - No playlist found with this Id"});
      }
      else if (error.name == 'SongNotInPlaylistError') {
        res
          .status(404)
          .send({error:"404 - Song not in playlist"});
      }
      else {
        res
          .status(500)
          .send({error:"500 - Unknown Delete Song from Playlist Error"});
      }
    });
});


// END add and remove songs from playlists
//***************************************************************************
//***************************************************************************
// START Get songs by Artist
//***************************************************************************
// Takes artist name as a parameter string, returns all songs with
// that string in the artist field

function getSongsByArtist(req) {
  const results = {};
  const query = datastore.createQuery('song').filter('artist', '=', req);
  return datastore.runQuery(query).then ( (entities) => {
    results.items = entities[0].map(fromDatastore);
    return entities;
  }).then( (entities) => {
    results.totalSearchResults = entities[0].length;
    console.log(entities);
    return results;
  });
}

app.get('/songs/artists/:artist', (req, res) => {
  const songs = getSongsByArtist(req.params.artist)
  .then((songs) => {
    console.log(songs);
    res
      .status(200)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", 
              "Origin, X-Requested-With, Content-Type, Accept")
      .json(songs);
  });
});

//***************************************************************************
// START Get songs by Album
//***************************************************************************
// Takes album name as a parameter string, returns all songs with
// that string in the album field


function getSongsByAlbum(req) {
  const results = {};
  const query = datastore.createQuery('song').filter('album', '=', req);
  return datastore.runQuery(query).then ( (entities) => {
    results.items = entities[0].map(fromDatastore);
    return entities;
  }).then( (entities) => {
    results.totalSearchResults = entities[0].length;
    console.log(entities);
    return results;
  });
}

app.get('/songs/albums/:album', (req, res) => {
  const songs = getSongsByAlbum(req.params.album)
  .then((songs) => {
    console.log(songs);
    res
      .status(200)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Headers", 
              "Origin, X-Requested-With, Content-Type, Accept")
      .json(songs);
  });
});

//----------------Other Stuff---------------//



app.get('/', (req, res, next) => {
  console.log("the app is running");
  res.send("Nunki Music Server is up");
});


app.use(function(req, res){
  res.status(404)
  .header("Access-Control-Allow-Origin", "*")
  .header("Access-Control-Allow-Headers", 
     "Origin, X-Requested-With, Content-Type, Accept")
  .send('404 - Not Found')
});



const PORT = process.env.PORT || 8080;
app.listen(process.env.PORT || 8080, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});

