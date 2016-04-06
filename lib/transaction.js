'use strict';

/* The purpose of this schema is to allow you to modify 2 documents in
a collection, or roll back, creating a psuedo transaction system */

var mongoose          = require('mongoose');
var Schema            = mongoose.Schema;
var ObjectId          = mongoose.Schema.Types.ObjectId;
var Mixed             = mongoose.Schema.Types.Mixed;

var async             = require('async');
var validator         = require('./validator');
var actions           = require('./actions');

var states = [
 'new', 'started', 'error', 'cancelling',
 'cancelled', 'cancelerror', 'done'
];

var errcode = {
  E_TIMEOUT: 'transaction timeout reached',
  E_CANNOT_START: 'Transaction cannot start: ',
  E_FETCH_PREV: 'Error fetching previous version',
  E_PREV_SAVE: 'Transaction prev cant be saved: ',
  E_CHANGE_START: 'Transaction change cant be started in: ',
  E_INVALID_ACTION: 'Transaction change includes invalid action: ',
  E_CHANGE_UPDATE: 'Transaction change cant be updated in: ',
  E_FINISH: 'Transaction cannot finish in current state: ',
  E_REVERT: 'Transaction cannot revert: ',
  E_CLEANUP: 'Transaction cannot be cleaned up: ',
  E_CHANGE_CANCEL: 'Transaction change cant be cancelled in: ',
  E_FAILED: 'Transaction failed; Change cant be found to revert: ',
  E_CHANGE_REVERT: 'Change cant be reverted. ',
  E_MARK_ERROR: 'Cant mark transaction as errored: ',
  E_ROLLBACK_SUCCESS: 'Transaction failed, but was rolled back successfully.',
  E_ROLLBACK_REMOVE: 'Transaction failed, but was rolled back successfully, but not removed'
};

var getNewCopy = {
  new: true, //return new version of doc 
  upsert: false //do not insert if it doesnt exist
};

// by Tz

var SPull = new Schema({
  to: String, //field name of array to push data into
  data: Mixed,
  v: Number
});

var SPush = new Schema({
  from: String, //field name of array to push data into
  data: Mixed,
  v: Number
});

//

var Change = new Schema({
  coll: {type: String}, //name of collection
  docId: {type: ObjectId}, //document to modify
  act: {
    type: String, 
    enum: ['insert', 'update', 'upsert', 'remove'], 
    required: true
  },
  prev: Mixed, //copy of previous state for rollback
  inc: Mixed, //object for incrementing multiple fields
  data: Mixed, //object containing all fields that need to be set
  push: {type: SPush},
  pull: {type: SPull},
  //push: {
  //  to: String, //field name of array to push data into
  //  data: Mixed,
  //  v: Number //optionally limit this to a document version
  //},
  //pull: {
  //  from: String,
  //  data: Mixed,
  //  v: Number
  //},
  state: {type: String},
  msg: String // any error or state messages
});


var Transaction = new Schema({
  app: {type: String, required: true}, //the originator of this request
  created: { type: Date, default: Date.now },
  lastModified: { type: Date, default: Date.now },
  state: {type: String, enum: states, default: states[0]},
  changes: {type: [Change], required: true},
  delayed: {type: Number, default: 0}
});

//do not allow multiple changes to be requested for the same document 
Transaction.index({'changes.docId':1}, {unique: true});

//validate change requests
Transaction.pre('save', validator);

Transaction.statics.create = function(tx, timeout, callback){
  if(typeof timeout === 'function'){
    callback = timeout; //allow skipping of timeout
    timeout = 5 * 1e3;
  }
  tx = new Transaction(tx);
  tx.save(function(err){
    if(err && err.message && err.message.indexOf('E11000 ') !== -1) {  // Duplicate key
      var giveUp = false;
      var delay = 20;
      if(tx.delayed) { 
        if(tx.delayed >= timeout) {
          giveUp = true;
        } 
        tx.delayed += delay;
      }
      else {tx.delayed = delay; }
      if(!giveUp){
        //setTimeout(Transaction.create(tx, timeout, callback), delay);
        setTimeout(function() {
          Transaction.create(tx, timeout, callback);
        }, delay);
      } else {
        callback(new Error(errcode.E_TIMEOUT));
      }
    }else if(err){
      throw err;
    }else{
      tx.start(callback);
    }
  });
};

Transaction.methods.start = function(callback){
  var self = this;
  self.fetchPreviousVersions(function(err, tx){
    if(err) { return callback(err); }
    self = tx;
    Transaction.findOneAndUpdate(
      {
        _id: self._id, 
        state: states[0]
      }, 
      {
        state: states[1], 
        lastModified: Date.now(), 
        $inc: {__v: 1}
      }, 
      getNewCopy, 
      function(err,doc){
        if(err){ throw err; }
        if(!doc){ 
          var errMsg = errcode.E_CANNOT_START + self._id;
          callback(new Error(errMsg));
        }else{
          doc.startChanges(callback);
        }
      }
    );
  });
};

Transaction.methods.fetchPreviousVersions = function(callback){
  var self = this;
  async.eachSeries(
    self.changes,
    function(change, callback){
      self.fetchPreviousVersion(self, change, callback);
    },
    function(err){
      callback(err, self);
    }
  );
};

Transaction.methods.fetchPreviousVersion = function(tx, change, callback){
  var self = tx;
  var prev;
  actions.findOne(change, function(err, cdoc){
    if(err) { 
      throw new Error(errcode.E_FETCH_PREV);
    }else{
      prev = cdoc;
    }
    Transaction.findOneAndUpdate(
      {
        _id: self._id, 
        'changes.docId': change.docId
      },
      {
        $set: {'changes.$.prev': prev}, 
        lastModified: Date.now(), 
        $inc: {__v: 1}
      },
      getNewCopy,
      function(err, doc){
        if(err){ throw err; }
        if(!doc){
          var errMsg = errcode.E_PREV_SAVE +self._id;
          callback(new Error(errMsg));
        }else{
          callback();
        }
      }
    );
  });
};

Transaction.methods.startChanges = function(callback){
  var self = this;
  async.eachSeries(
    self.changes,
    function(change, callback){
      self.startChange(self, change, callback);
    },
    function(err){
      if(err) { self.revert(err, callback); }
      else { self.finish(callback); }
    }
  );
};

Transaction.methods.startChange = function(self, change, callback){
  //had to pass 'self' in manually
    Transaction.findOneAndUpdate(
      {
        _id: self._id, 
        'changes.docId': change.docId,
        'changes.state': 'new'
      },
      {
        $set: {'changes.$.state': 'started'}, 
        lastModified: Date.now(), 
        $inc: {__v: 1}
      },
      getNewCopy,
      function(err, doc){
        if(err){ throw err; }
        if(!doc){
          var errMsg = errcode.E_CHANGE_START + self._id;
          callback(new Error(errMsg));
        }else{
          change.state = 'started';
          doc.doChange(change, callback);
        }
      }
    );
};

Transaction.methods.doChange = function(change, callback){
  var self = this;
  var handler = self.handleChangeResult;
  if(change.act === 'insert') { 
    self.doInsert(self, change, handler, callback); 
  }
  else if(change.act === 'update') { 
    self.doUpdate(self, change, handler, callback); 
  }
  else if(change.act === 'upsert') { 
    self.doUpsert(self, change, handler, callback); 
  }
  else if(change.act === 'remove') { 
    self.doRemove(self, change, handler, callback); 
  }
  else{
    var errMsg = errcode.E_INVALID_ACTION + self._id;
    handler(self, change, errMsg, 'error', callback);
  }
};

Transaction.methods.handleChangeResult = function(tx, change, msg, state, cb){
  var self = tx;
  Transaction.findOneAndUpdate(
    {
      _id: self._id, 
      __v: self.__v, //make sure version hasnt changed
      'changes.docId': change.docId
    },
    {
      $set: {
        'changes.$.state': state,
        'changes.$.msg': msg,
      }, 
      lastModified: Date.now(), 
      $inc: {__v: 1}
    },
    getNewCopy,
    function(err, doc){
      if(err){ throw err; }
      if(!doc){
        var errMsg = errcode.E_CHANGE_UPDATE + self._id;
        cb(new Error(errMsg));
      }else{
        if(state === 'error'){
          cb(new Error(change.coll +': '+ change.docId +': '+ msg));
        }else{
          cb();
        }
      }
    }
  );
};

var erros = {
  0: "",
  1: ""
}

Transaction.methods.finish = function(callback){
  var self = this;
  var badChangeStates = [];
  states.forEach(function(state){
    badChangeStates.push({'changes.state': state});
  });
  badChangeStates.pop(); // last state is success, not bad
  Transaction.findOneAndRemove(
    {
      _id: self._id, 
      state: states[1],
      $nor: badChangeStates
    },
    function(err, doc){
      if(err){ throw err; }
      if(!doc){
        var errMsg = errcode.E_FINISH + self._id;
        callback(new Error(errMsg));
        var e = new Error(errors[0]);
        e.code = 0;
        e.objId = self._id;
      }else{
        callback();
      }
    }
  );
};

Transaction.methods.revert = function(err, callback){
  var self = this;
  Transaction.findOneAndUpdate(
    {
      _id: self._id, 
      state: states[1],
      'changes.state': 'error'
    }, 
    {
      state: states[2], //cancelling 
      lastModified: Date.now(), 
      $inc: {__v: 1}
    }, 
    getNewCopy, 
    function(err,doc){
      if(err){ throw err; }
      if(!doc){ 
        var errMsg = errcode.E_REVERT + self._id;
        callback(new Error(errMsg));
      }else{
        doc.revertChanges(callback);
      }
    }
  );
};

Transaction.statics.cleanupOldJobs = function(expiredDate, app, callback){
  var q = {lastModified: {$gte: expiredDate}};
  if(app) { q.app = app; }
  Transaction.find(q, function(err, txs){
    if(err){ throw err; }
    async.each(
      txs,
      Transaction.cleanupOld,
      callback
    );
  });
};

Transaction.statics.cleanupOld = function(tx, callback){
  Transaction.findOneAndUpdate(
    {
      _id: tx._id
    }, 
    {
      state: states[2], //cancelling 
      lastModified: Date.now(), 
      $inc: {__v: 1}
    }, 
    getNewCopy, 
    function(err,doc){
      if(err){ throw err; }
      if(!doc){ 
        var errMsg = errcode.E_CLEANUP + tx._id;
        callback(new Error(errMsg));
      }else{
        doc.revertChanges(callback);
      }
    }
  );
};

Transaction.methods.revertChanges = function(callback){
  var self = this;
  async.eachSeries(
    self.changes,
    function(change, callback){
      self.revertChange(self, change, callback);
    },
    function(err){
      if(err) { self.failRevert(err); }
      else { self.completeRevert(callback); }
    }
  );
};

Transaction.methods.revertChange = function(self, change, callback){
  //had to pass 'self' in manually
  if(change.state === 'new' || change.state === 'error'){
    Transaction.findOneAndUpdate(
      {
        _id: self._id, 
        'changes.docId': change.docId,
        'changes.state': change.state
      },
      {
        $set: {'changes.$.state': 'cancelled'}, 
        lastModified: Date.now(), 
        $inc: {__v: 1}
      },
      getNewCopy,
      function(err, doc){
        if(err){ throw err; }
        if(!doc){
          var errMsg = 'Transaction change cant be cancelled in: '+self._id;
          callback(new Error(errMsg));
        }else{
          callback(err, doc);
        }
      }
    );
  }else{
    //actually have to revert the change here
    Transaction.findOneAndUpdate(
      {
        _id: self._id, 
        'changes.docId': change.docId,
        'changes.state': change.state
      },
      {
        $set: {'changes.$.state': 'cancelling'}, 
        lastModified: Date.now(), 
        $inc: {__v: 1}
      },
      getNewCopy,
      function(err, doc){
        if(err){ throw err; }
        if(!doc){
          var errMsg = errcode.E_CHANGE_CANCEL + self._id;
          callback(new Error(errMsg));
        }else{
          change.state = 'cancelling';
          doc.doRevert(change, callback);
        }
      }
    );
  }
};

Transaction.methods.doRevert = function(change, callback){
  var self = this;
  var handler = self.handleRevertResult;
  if(change.act === 'insert') { 
    self.doRevertInsert(self, change, handler, callback); 
  }
  else if(change.act === 'update') { 
    self.doRevertUpdate(self, change, handler, callback); 
  }
  else if(change.act === 'upsert') { 
    self.doRevertUpsert(self, change, handler, callback); 
  }
  else if(change.act === 'remove') { 
    self.doRevertRemove(self, change, handler, callback); 
  }
  else{
    var errMsg = errcode.E_INVALID_ACTION + self._id;
    handler(self, change, errMsg, 'error', callback);
  }
};

Transaction.methods.handleRevertResult = function(tx, change, msg, state, cb){
  var self = tx;
  Transaction.findOneAndUpdate(
    {
      _id: self._id, 
      __v: self.__v, //make sure version hasnt changed
      'changes.docId': change.docId
    },
    {
      $set: {
        'changes.$.state': state,
        'changes.$.msg': msg,
      }, 
      lastModified: Date.now(), 
      $inc: {__v: 1}
    },
    getNewCopy,
    function(err, doc){
      var errMsg;
      if(err){ throw err; }
      if(!doc){
        errMsg = errcode.E_FAILED;
        errMsg += self._id;
        cb(new Error(errMsg));
      }else{
        if(state === 'cancelerror'){
          errMsg = E_CHANGE_REVERT;
          errMsg += change.coll +': '+ change.docId +': '+ msg;
          cb(new Error(errMsg));
        }else{
          cb();
        }
      }
    }
  );
};

Transaction.methods.failRevert = function(revErr){
  //mark entire transaction as 'error', and callback error
  var self = this;
  Transaction.findOneAndUpdate(
    {
      _id: self._id
    },
    {
      $set: {
        state: 'error'
      }, 
      lastModified: Date.now(), 
      $inc: {__v: 1}
    },
    getNewCopy,
    function(err, doc){
      if(err){
        throw err;
      }else if(!doc){
        throw new Error(errcode.E_MARK_ERROR+self._id);
      }else{
        throw new Error(revErr);
      }
    }
  );
};

Transaction.methods.completeRevert = function(callback){
  //transaction failed, but was rolled back successfully
  var errMsg = errcode.E_ROLLBACK_SUCCESS;
  this.remove(function(err) {
    if (err) callback(new Error(errcode.E_ROLLBACK_REMOVE));
    callback(new Error(errMsg));
  });

};




Transaction.methods.doInsert = actions.insert;

Transaction.methods.doUpdate = actions.update;

Transaction.methods.doUpsert = actions.upsert;

Transaction.methods.doRemove = actions.remove;

Transaction.methods.doRevertInsert = actions.revertInsert;

Transaction.methods.doRevertUpdate = actions.revertUpdate;

Transaction.methods.doRevertUpsert = actions.revertUpsert;

Transaction.methods.doRevertRemove = actions.revertRemove;

module.exports = Transaction = mongoose.model('Transaction', Transaction);
