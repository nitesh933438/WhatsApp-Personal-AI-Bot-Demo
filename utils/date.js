exports.now = () => {

return new Date();

};

exports.format = (date)=>{

return new Date(date)

.toLocaleString("en-IN");

};