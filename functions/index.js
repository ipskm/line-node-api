/*
  HEADER
*/
const functions = require('firebase-functions')
const request = require('request-promise')

const admin = require('firebase-admin')
admin.initializeApp()

const region = 'asia-east2'
const runtimeOpts = {
  timeoutSecounds: 4,
  memory: '2GB'
}

const vision = require('@google-cloud/vision')
const client = new vision.ImageAnnotatorClient()

const LINE_MESSAGING_API = 'https://api.line.me/v2/bot/message'
const LINE_HEADER = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer hLJkssN2HV+CgC5v7iKKkGpZONh7oiCK/KkBj7/g9+O/JsqXOmmv+RZmI30dKPt9goBw/kHOB709fWGSofLWPSeE+oUp1I+ezPK/BM2y3uOl1UwppNonMLoL7vqEHSVuep+yD+xTeqiJFex5NFelGwdB04t89/1O/w1cDnyilFU='
}
//change Bearer (Channel access token)
/*
  EXPORT FUNCTIONS
*/

exports.webhook = functions.region(region).runWith(runtimeOpts).https.onRequest(async (req, res) => {
  let event = req.body.events[0]
  switch (event.type) {
    case 'message':
      if (event.message.type === 'image') {
        doImage(event)
      } else if (event.message.type === 'text') {
        postToDialogflow(req)
      } else {
        replyPayload(req)
      }
      break;
    case 'postback': {
      let msg = 'ทีมที่คุณเลือกมันเข้ารอบมาชิง UCL ซะทีไหนเล่า ปั๊ดโถ่!';
      let team = event.postback.data.split('=')[1]
      if (team.indexOf('liverpool') >= 0 || team.indexOf('tottenham') >= 0) {
        // Firebase Realtime Database
        await admin.database().ref('ucl/uid').child(event.source.userId).set(true)

        // Cloud Firestore
        // await admin.firestore().doc('ucl/final').collection('uid').doc(event.source.userId).set({})

        msg = 'ยินดีด้วยคุณผ่านการยืนยันตัวตน ระบบจะรายงานผลบอลคู่ชิงคู่นี้ให้คุณทุกลมหายใจ';
      }
      reply(event.replyToken, { type: 'text', text: msg });
      break;
    }
  }
  return res.status(200).send(req.method)
})

const replyPayload = req => {
  let event = req.body.events[0]
  return request({
    method: "POST",
    uri: `${LINE_MESSAGING_API}/reply`,
    headers: LINE_HEADER,
    body: JSON.stringify({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: JSON.stringify(req.body)
        }
      ]
    })
  })
}

const postToDialogflow = req => {
  req.headers.host = "bots.dialogflow.com";
  return request({
    method: "POST",
    uri: "https://bots.dialogflow.com/line/2efc9220-9e12-4854-aec1-22ba8a794024/webhook",//Change to your dialogflow webhook
    headers: req.headers,
    body: JSON.stringify(req.body)
  })
}

const doImage = async (event) => {
  const path = require("path")
  const os = require("os")
  const fs = require("fs")

  // กำหนด URL ในการไปดึง binary จาก LINE กรณีผู้ใช้อัพโหลดภาพมาเอง
  let url = `${LINE_MESSAGING_API}/${event.message.id}/content`

  // ตรวจสอบว่าภาพนั้นถูกส่งมจาก LIFF หรือไม่
  if (event.message.contentProvider.type === 'external') {
    // กำหนด URL รูปภาพที่ LIFF ส่งมา 
    url = event.message.contentProvider.originalContentUrl
  }

  // ดาวน์โหลด binary
  let buffer = await request.get({
    headers: LINE_HEADER,
    uri: url,
    encoding: null // แก้ปัญหา binary ไม่สมบูรณ์จาก default encoding ที่เป็น utf-8
  })

  // สร้างไฟล์ temp ใน local จาก binary ที่ได้
  const tempLocalFile = path.join(os.tmpdir(), 'temp.jpg')
  await fs.writeFileSync(tempLocalFile, buffer)

  // กำหนดชื่อ bucket ใน Cloud Storage for Firebase
  const bucket = admin.storage().bucket('cpe-camp-4th-243901.appspot.com') //Change your bucket name

  // อัพโหลดไฟล์ขึ้น Cloud Storage for Firebase
  await bucket.upload(tempLocalFile, {
    destination: `${event.source.userId}.jpg`, // ให้ชื่อไฟล์เป็น userId ของ LINE
    metadata: { cacheControl: 'no-cache' }
  });

  /// ลบไฟล์ temp หลังจากอัพโหลดเสร็จ
  fs.unlinkSync(tempLocalFile)

  // ตอบกลับเพื่อ handle UX เนื่องจากทั้งดาวน์โหลดและอัพโหลดต้องใช้เวลา
  reply(event.replyToken, { type: 'text', text: 'ขอคิดแป๊บนะเตง...' })

}

exports.logoDetection = functions.region(region).runWith(runtimeOpts)
  .storage.object()
  .onFinalize(async (object) => {
  const fileName = object.name // ดึงชื่อไฟล์มา
  const userId = fileName.split('.')[0] // แยกชื่อไฟล์ออกมา ซึ่งมันก็คือ userId

  // ทำนายโลโกที่อยู่ในภาพด้วย Cloud Vision API
  const [result] = await client.logoDetection(`gs://${object.bucket}/${fileName}`)
  const logos = result.logoAnnotations;
  
  // เอาผลลัพธ์มาเก็บใน array ซึ่งเป็นโครงสร้างของ Quick Reply
  let itemArray = []
  logos.forEach(logo => {
    if (logo.score >= 0.7) { // ค่าความแม่นยำของการทำนายต้องได้ตั้งแต่ 70% ขึ้นไป
      itemArray.push({
        type: 'action',
        action: {
          type: 'postback', // action ประเภท postback
          label: logo.description, // ชื่อที่จะแสดงในปุ่ม Quick Reply
          data: `team=${logo.description}`, // ส่งข้อมูลทีมกลับไปแบบลับๆ
          displayText: logo.description // ชื่อที่จะถูกส่งเข้าห้องแชทหลังจากคลิกปุ่ม Quick Reply
        }
      })
    }
  })
  
  // กำหนดตัวแปรมา 2 ตัว
  let msg = ''
  let quickItems = null
  
  // ตรวจสอบว่ามีผลลัพธ์การทำนายหรือไม่
  if (itemArray.length > 0) {
    msg = 'เลือกทีมที่คิดว่าใช่มาหน่อยซิ'
    quickItems = { items: itemArray }
  } else {
    msg = 'ไม่พบโลโกในภาพ ลองส่งรูปมาใหม่ซิ'
    quickItems = null
  }
  
  // ส่งข้อความหาผู้ใช้ว่าพบโลโกหรือไม่ พร้อม Quick Reply(กรณีมีผลการทำนาย)
  push(userId, msg, quickItems)
})

/*
  REPLY METHOD
*/
// Push Message
const push = (userId, msg, quickItems) => {
  return request.post({
    headers: LINE_HEADER,
    uri: `${LINE_MESSAGING_API}/push`,
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: msg, quickReply: quickItems }]
    })
  })
}

// Reply Message
const reply = (token, payload) => {
  return request.post({
    uri: `${LINE_MESSAGING_API}/reply`,
    headers: LINE_HEADER,
    body: JSON.stringify({
      replyToken: token,
      messages: [payload]
    })
  })
}
