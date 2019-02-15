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

//const mp3Duration = require('mp3-duration'); // get length of mp3 in ms
const getMP3Duration = require('get-mp3-duration'); // get length of mp3 in ms

const request = require('request');
const rp = require('request-promise');
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
    fileSize: 5 * 2048 * 2048 // no larger than 5mb, change as needed
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


/***************************************************************************
****************************************************************************
  START HTTP Actions
****************************************************************************
***************************************************************************/

//***************************************************************************
// START Upload a Song
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

    var publicUrl = "placeholder you should not see";
    blobStream.on('finish', ()=>{
      const publicUrl = format(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
      console.log("in finish");
      console.log(publicUrl);
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

  // console.log(`gs://${bucketName}/${filename} is now public.`);
}

/* POST method 
   Takes name, artist, and album as text fields, source and artwork
   as files in request body.
   Saves files to bucket and song object to datastore
   returns a song object that contains:
   name, artist, album, duration(ms), source url, artwork url,
   self url (in datastore), and datastore id number
*/

app.post('/songs', multer.fields([{ name: 'artwork', maxCount: 1},
                                  { name: 'source', maxCount: 1}]),
                                (req, res) => {

  var song = {"name": req.body.name, 
              "artist": req.body.artist,
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
      .json(song)
      .end();
  }).catch( (err) => {
    res
      .status(500)
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
  // second query to get total count of search results available
  var p = datastore.createQuery('song');
  const results = {};
//  if(Object.keys(req.query).includes("cursor")){
//    q = q.start(req.query.cursor);
//  }
  return datastore.runQuery(q).then ( (entities) => {
    results.items = entities[0].map(fromDatastore);
//    if (entities[1].moreResults !== Datastore.NO_MORE_RESULTS) {
//      results.next = (BASEURL + "/songs?cursor=" + entities[1].endCursor);
//    }
  }).then( () => {
    return datastore.runQuery(p);
  }).then( (entities) => {
    results.totalSearchResults = entities[0].length;
    console.log("after query entities");
    console.log(entities);
    return results;
  });
}

app.get('/songs', (req, res) => {
  const songs = getSongs(req)
    .then((songs) => {
//      const accepts = req.accepts(['application/json']);
//      if(!accepts) {
//        res
//          .status(406)
//          .send({ error:"Not Acceptable - must accept application/json"});
//      }
//      else {
        console.log(songs);
        res
          .status(200)
          .json(songs);
//      }
    });
});

// END List all songs
//***************************************************************************


//***************************************************************************
// START Post new playlist
//***************************************************************************

async function listSearch(listId) {
  const listKey = datastore.key(['list', parseInt(listId,10)]);
  const query = datastore.createQuery('list').filter('__key__', '=', listKey);
  return datastore.runQuery(query);
}

async function validateList(listId) {
  const listKey = datastore.key(['list', parseInt(listId,10)]);
  return listSearch(listId).then (results => {
    if (results[0].length > 0) {
      console.log("listSearch results len > 0");
      const query = datastore.createQuery('list').filter('__key__', '=', listKey);
      return datastore.runQuery(query);
    }
    else {
      console.log("listSearch results len not > 0");
      var e = new Error;
      e.name = 'InvalidListIdError';
      throw e;
    };
  });
}
// takes: list json object with name
//
// returns: a list key with the newly assigned id
function postList(list) {
  const key = datastore.key('list');
  return datastore.save({"key": key, "data": list})
  .then(() => {return key})
  // get the key back from the first save, use it in the self link and resave
  .then ( (result) => {


    console.log("in postlist, here list");
    console.log(list);

    list.self = (BASEURL + "/lists/" + key.id);
    list.songs = [];
    return datastore.save({"key": key, "data": list})
  }).then(() => {return key});
    
}

app.post('/lists', (req, res) => {
  var list = {"name": req.body.name};
  
  console.log("in post, here req");
  console.log(req);
  console.log("in post, here list");
  console.log(list);

  return postList(list).then(result => {
    list.id = result.id;
    res
      .status(201)
      .json(list)
      .end();
  }).catch( (err) => {
    res
      .status(500)
      .send('500 - Unknown post playlist error')
      .end()
  });
});

// END Post new playlist
//***************************************************************************



// TODO rewrite to use datastore instead of buckets
//***************************************************************************
// START List all songs in a Bucket
//***************************************************************************
// Helper function
// Takes a bucket name
// Returns json of all files in that bucket

/*


async function listFiles(bucketName) {

  // Lists files in the bucket
  const [files] = await storage.bucket(bucketName).getFiles();

//  console.log('Files:');
//  files.forEach(file => {
//    console.log(file.name);
//  });
  return files
}

// get a list of songs on the server
// uses const global name of bucketName for now

app.get('/songs/', (req, res) => {
  const songs = listFiles(bucketName)
    .then((songs) => {
      //console.log(songs)
      res
        .status(200)
        .json(songs);
    }).catch(function(error) {
      console.log(error);
      res
        .status(500)
        .send({error:"500 - Unknown Get Songs Error"});
    });
});


*/

// END List Songs
//****************************************************************************









//----------------Legacy---------------//

// This is the sample that can stream directly from bucket to browser
// Don't think we need it, but keeping just in case

app.get('/test2', (req, res) => {
  var file = bucket.file('tones.mp3');

  console.log('here1');

  res.set('content-type', 'audio/mp3');
  res.set('accept-ranges', 'bytes');

  file.createReadStream()
    .on('error', function(err) {})
    .on('response', function(response) {
        })
    .on('end', function() {
        })
    .pipe(res);

  
});


//----------------Other Stuff---------------//

app.get('/', (req, res, next) => {
  console.log("the app is running");
  res.send("Nunki Music App");
});


app.use(function(req, res){
  res.status(404);
  res.send('404 - Not Found')
});



const PORT = process.env.PORT || 8080;
app.listen(process.env.PORT || 8080, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});

/*
// Original for posting a file directly to a Bucket
// Process the file upload and upload to Google Cloud Storage.
app.post('/upload', multer.single('file'), (req, res, next) => {
  if (!req.file) {
    res.status(400).send('No file uploaded.');
    return;
  }

  // Create a new blob in the bucket and upload the file data.
  const blob = bucket.file(req.file.originalname);
  const blobStream = blob.createWriteStream({
    resumable: false
  });

  blobStream.on('error', (err) => {
    next(err);
  });

  blobStream.on('finish', () => {
    // The public URL can be used to directly access the file via HTTP.
    const publicUrl = format(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
    res.status(200).send(publicUrl);
  });

  blobStream.end(req.file.buffer);
});

*/
