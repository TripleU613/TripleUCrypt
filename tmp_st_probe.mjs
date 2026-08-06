import express from 'express';
const app=express();
app.use(express.static('/home/tripleu/TripleUCrypt/dist/public'));
app.listen(8412,()=>console.log('up'));
