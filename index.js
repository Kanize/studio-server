import express from 'express'
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';





const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());



const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoclient = await connectToMongoDB();

const db = mongoclient.db('studio-space');
const studiosCollection = db.collection('studios');

// http://localhost:8000/add-studio



app.get('/', (req, res) => {
  res.send({ message: 'Server is running fine!' });
});


app.post('/add-studio', async (req, res) => {
  const data = req.body;
    const result = await studiosCollection.insertOne(data);
    console.log('Studio added successfully:', result);

    res.send(result);
});

app.get('/studios', async (req, res) => {
  try {
    const studios = await studiosCollection.find().toArray();
    res.send(studios);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error fetching studios' });
  }
});

app.get('/studios/:id', async (req, res) => {
  const {id} = req.params;
    const studio = await studiosCollection.findOne({ _id: new ObjectId(id) });
    res.send(studio);

});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});