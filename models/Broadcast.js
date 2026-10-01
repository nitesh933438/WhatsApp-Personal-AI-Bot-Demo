const mongoose=require("mongoose");

module.exports=

mongoose.model(

"Broadcast",

new mongoose.Schema({

message:String,

total:Number,

date:{

type:Date,

default:Date.now

}

})
);