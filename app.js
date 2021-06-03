require('dotenv').config()
const express = require("express")
const bodyParser = require("body-parser")
const ejs = require("ejs")
const mongoose = require("mongoose")
const https = require("https")
const session = require("express-session")
const passport = require("passport")
const passportLocalMongoose = require("passport-local-mongoose")
const { resolve } = require('path')
const { get } = require('http')

const app = express()
app.use(bodyParser.urlencoded({extended: true}))
app.set("view engine", "ejs")
app.use(express.static("static"))

app.use(session({
    secret: "I actually liked JB's Baby",
    resave: false,
    saveUninitialized: false 
}))

app.use(passport.initialize())
app.use(passport.session())

const url = "mongodb://localhost:27017/stockdB"
mongoose.connect(url,{useNewUrlParser: true, useUnifiedTopology: true,useCreateIndex: true,})

const api_first = "https://cloud.iexapis.com/stable/stock/"
const api_second = "/quote?token=" + process.env.API_KEY

const dbschema = new mongoose.Schema({
    username: String,
    password: String,
    balance: {
        type: Number,
        default: 10000
    }    
})

dbschema.plugin(passportLocalMongoose)

const User = new mongoose.model("User", dbschema)

const transdb = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    symbol: String,
    price: Number,
    shares: Number,
    time: String
})

const Transaction = new mongoose.model("Transaction", transdb)


passport.use(User.createStrategy());

passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

function addStock(req, symbol, price, num) {

    if(req.user)
    {
        const stock = new Transaction({
            user_id: req.user._id,
            symbol: symbol,
            price: price,
            shares: num,
            time: new Date().toLocaleString()  
        })

        stock.save()
        req.user.save()
    }
}

function getStock(symbol) {
    return new Promise(function(resolve, reject){

        let api_url = api_first + symbol + api_second
        let obj
        
        https.get(api_url, function(resp){
            resp.on("data", function(data){

                obj = JSON.parse(data)

                let stock = {
                    name: obj.companyName,
                    symbol: obj.symbol,
                    price: obj.latestPrice
                }

                resolve(stock)
            })
        })
    })
}

function getCurrentStocks(req) {
    return new Promise(function(resolve, reject){
        Transaction.aggregate([
            {$match: {user_id: req.user._id}},
            {$group: {_id: "$symbol", count: {$sum: "$shares"}}},
            {$match: {count: {$gte: 1}}},
            {$sort: {_id: 1}}
        ], 
        function(err, stocks){
            resolve(stocks)
        })
    })
}

function getCount(req, symbol) {
    return new Promise(function(resolve, reject){
        
        Transaction.aggregate([
            {$match: {user_id: req.user._id, symbol: symbol}}, 
            
            {$group: {_id: "$symbol", count: {$sum: "$shares"} } },
        ],   
        function(err, stocks){
            if(!err)
            {
                resolve(stocks[0].count)
            }
        })
    })
}

app.route("/register")
    .get(function(req, res){

        res.render("register",{})
    })
    .post(function(req, res){

        User.register({username: req.body.username}, req.body.password, function(err, user){
            if(err)
                res.redirect("/register")
            else
            {    
                passport.authenticate("local")(req, res,function(){
                    res.redirect("/index")
                })
            }
        })
    })

app.route("/login")
    .get(function(req, res){

        res.render("login",{})
    })
    .post(function(req, res){

        const user = new User({
            username: req.body.username,
            password: req.body.password
        })

        req.login(user, function(err){
            if(!err)
            {
                passport.authenticate("local")(req,res, function(){
                    res.redirect("/index")
                })
            }
            else
            {
                console.log(err)
                res.redirect("login")
            }
        })
    })

app.route("/index")
    .get(async function(req, res){

        if(req.user)
        {
            let currstocks = await getCurrentStocks(req)
            let stocks = []
            let cashinstocks = 0;

            function addPrices(currstocks) {
                return new Promise(async function(resolve, reject) {
                    for(let i = 0;i < currstocks.length; i++) {
                        let temp = await getStock(currstocks[i]._id)
                        
                        let stock = {
                            symbol: currstocks[i]._id,
                            name: temp.name,
                            shares: currstocks[i].count,
                            price: temp.price,
                            cost:  Math.round(currstocks[i].count * temp.price * 100)/100,
                        }

                        stocks.push(stock)
                        cashinstocks +=  stock.cost

                        if(i == currstocks.length - 1)
                            resolve(stocks)
                    }
                })
            }
            
            if(currstocks.length > 0)
            {
                stocks = await addPrices(currstocks)
            }

            cashinstocks = Math.round(cashinstocks * 100)/100
            let cash = Math.round(req.user.balance * 100)/100
            
            res.render("index", {stocks: stocks, cashinstocks: cashinstocks, balance: cash})
        }
        else
            res.redirect("/login")
    })


app.route("/quote")
    .get(function(req, res){

        res.render("quote",{})
    })
    .post(async function(req, res){

        let symbol = req.body.symbol;
        let stock = await getStock(symbol)
        res.render("quote_res", {stock: stock})
    })

app.route("/buy")
    .get(function(req, res){

        if(req.isAuthenticated())
            res.render("buy",{})
        else
            res.redirect("/login")
    })

    .post(async function(req, res){

        if(req.user)
        {
            let symbol = req.body.symbol
            let num = req.body.num

            let stock = await getStock(symbol)
            let acq_cost = stock.price * num

            if(acq_cost <= req.user.balance){
                
                req.user.balance -= acq_cost
                addStock(req, symbol, stock.price, num)
                res.redirect("index")
            }
            else
                res.send("Insufficient balance")
            

        }
        else
            res.redirect("/login")
    })

app.route("/sell")
    .get(async function(req, res){

        if(req.user)
        {
            res.render("sell",{stocks: await getCurrentStocks(req)})
        }
        else
            res.redirect("/login")
    })

    .post(async function(req, res){

        if(req.user)
        {

            let symbol = req.body.symbol
            let num = req.body.num

            let shares = await getCount(req, symbol)
            
            if(num <= shares)
            {
                let stock = await getStock(symbol)
                req.user.balance += (stock.price * num)
                addStock(req, symbol, stock.price, -1 * num)
                res.redirect("index")

            }
            else
                res.send("not enough shares")
        }
        else
            res.redirect("/login")
    })

app.route("/history")
    .get(function(req, res){

        if(req.user)
        {
            Transaction.find({user_id: req.user._id}, function(err, stocks){

                res.render("history", {stocks: stocks.reverse()})
            })
        }
    })

app.route("/logout")
    .get(function(req, res){

        req.logout();
        res.redirect("/")
    })

app.route("/")
    .get(function(req, res){
        res.render("home", {})
    })

app.listen(3000, function(req, res){
    console.log("server running")
})