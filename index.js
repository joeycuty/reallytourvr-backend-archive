var express = require('express');
var app = express();

var admin = require("firebase-admin");

admin.initializeApp({
    credential: admin.credential.cert("key.json"), //REMOVED PRIVATE DATA
    databaseURL: ""  //REMOVED PRIVATE DATA
});

var stripe = require("stripe")("PRIVATEKEYHERE");  //REMOVED PRIVATE DATA

var helper = require('sendgrid').mail

app.set('port', (process.env.PORT || 5000));

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.static(__dirname + '/public'));
var bodyParser = require('body-parser')
// views is directory for all template files
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

app.use(bodyParser.json())
app.get('/', function(request, response) {
    response.render('pages/index');
});


app.post("/inbound", function(request, response) {
  // Retrieve the request's body and parse it as JSON
  console.log(request.body);


  response.sendStatus(200);
});


var mailRef = admin.database().ref("mailQueue");

var sg = require('sendgrid')("PRIVATEEMAILERKEY");  //REMOVED PRIVATE DATA

mailRef.on('child_added', (data) => {

    var key = data.key;
    var obj = data.val();

    var to = obj['to'];
    var from = obj['from'];
    var title = obj['title'];

    var myMessage = obj['message'];

    var subject = 'ReallyTourVR - new message about your house, "' + title + '"';

    from_email = new helper.Email(from)
    to_email = new helper.Email(to)
    content = new helper.Content("text/plain", myMessage);
    mail = new helper.Mail(from_email, subject, to_email, content)

    var request = sg.emptyRequest({
        method: 'POST',
        path: '/v3/mail/send',
        body: mail.toJSON()
    });

    sg.API(request, function(error, response) {
        console.log(response.statusCode)
        console.log(response.body)
        console.log(response.headers)
    })

    obj['sent'] = Date.now();

    saveMsg(key, obj);

});


var stripeQueueRef = admin.database().ref("stripeQueue");

stripeQueueRef.on('child_added', (data) => {

    processStripe(data);

});

stripeQueueRef.on('child_changed', (data) => {

    processStripe(data);
});


var stripeUpdateRef = admin.database().ref("stripeUpdateQueue");

stripeUpdateRef.on('child_added', (data) => {

    processUpdateStripe(data);

});

stripeUpdateRef.on('child_changed', (data) => {

    processUpdateStripe(data);
});

var stripeComRef = admin.database().ref("stripeComReq");

stripeComRef.on('child_added', (data) => {

    processStripeCom(data);

});

stripeComRef.on('child_changed', (data) => {

    processStripeCom(data);
});


function saveMsg(key, obj) {
    var delRef = admin.database().ref("mailQueue/" + key).remove();

    return admin.database().ref("mailGlacier/" + key).update(obj);
}

function relayError(key, error) {

    return admin.database().ref("stripeQueue/" + key).update(error);
}

function processStripe(data) {
    console.log(data.key);
    console.log(data.val());

    var token = data.val()['token'];
    var plan = data.val()['plan'];
    var email = data.val()['email'];

    var last4 = token.card.last4;
    var cardBrand = token.card.brand;

    var userKey = data.key;
    var customerId = null;

    stripe.customers.create({
        source: token.id,
        description: email,
        email: email
    }).then((customer) => {

        customerId = customer.id;
        var myCustomer = customer;

        return stripe.subscriptions.create({
            customer: customer.id,
            plan: plan,
            trial_period_days: 5

        })
    }).then((sub) => {

        console.log(sub);

        var obj = {
            last4: last4,
            cardBrand: cardBrand,
            curPlan: plan,
            subscription: sub
        }

        saveSub(userKey, obj)
            .then(() => {

                console.log("USER SUBSRIPTION SAVED");

            });

    })
        .catch((error) => {


            console.log("=============ERR============");

            console.log(error);

            var errObj = {
                error: error.message
            };

            relayError(userKey, errObj);
        });
}

function relayUpdateError(key, error) {

    return admin.database().ref("stripeUpdateQueue/" + key).update(error);
}

function processUpdateStripe(data) {
    console.log(data.key);
    console.log(data.val());

    var token = data.val()['token'];
    var key = data.val()['key'];
    var type = data.val()['type'];

    var userKey = data.key;

    if (type == 'card') {
        var last4 = token.card.last4;
        var cardBrand = token.card.brand;

        stripe.customers.update(key, {
            source: token.id
        }, function(err, customer) {
            // asynchronously called

            if (err == null) {
                var obj = {
                    last4: last4,
                    cardBrand: cardBrand
                }

                saveUpdateSub(userKey, obj)
                    .then(() => {

                        console.log("USER SUBSRIPTION SAVED");

                    });

            } else

            {

                var errObj = {
                    error: err.message
                };

                relayUpdateError(userKey, errObj);
            }

        });
    } else if (type == 'plan') {
        stripe.subscriptions.update(key, { plan: token },
            function(err, subscription) {
                if (err == null) {
                    var obj = {
                        subscription: subscription
                    }

                    saveUpdateSub(userKey, obj)
                        .then(() => {

                            console.log("USER SUBSRIPTION SAVED");

                        });

                } else

                {

                    var errObj = {
                        error: err.message
                    };

                    relayUpdateError(userKey, errObj);
                }
            }
        );
    }
}

function processStripeCom(data) {
    console.log(data.key);
    console.log(data.val());

    var request = data.val();
    var userKey = data.key;

    if (request.type == 'prorate') {
        getProrate(userKey, request);
    }

}

function getProrate(key, obj) {

    var customerId = obj['cus'];
    var subId = obj['sub'];
    var plan = obj['plan'];

    var proration_date = Math.floor(Date.now() / 1000);

    // See what the next invoice would look like with a plan switch
    // and proration set:
    stripe.invoices.retrieveUpcoming(
        customerId,
        subId, {
            subscription_plan: plan, // Switch to new plan
            subscription_proration_date: proration_date
        }, (err, invoice) => {
            // asynchronously called
            if (err === null) { 
                // Calculate the proration cost:
                var current_prorations = [];
                var cost = 0.00;
                for (var i = 0; i < invoice.lines.data.length; i++) {
                    var invoice_item = invoice.lines.data[i];
                    if (invoice_item.period.start == proration_date) {
                        current_prorations.push(invoice_item);
                        cost += invoice_item.amount;
                    }

                }

                var realcost = 0.00;

                realcost = cost / 100;



                var send = { cost: cost };

                stripeComRes(key, send)

            } else {
                // handle error
            }
        }
    );
}

function saveSub(key, obj) {
    var delRef = admin.database().ref("stripeQueue/" + key).remove();

    admin.database().ref("Users/" + key).update({ newUser: 3 });

    return admin.database().ref("UsersSecure/" + key).update(obj);
}

function saveUpdateSub(key, obj) {
    var delRef = admin.database().ref("stripeUpdateQueue/" + key).remove();

    return admin.database().ref("UsersSecure/" + key).update(obj);
}

function stripeComRes(key, obj) {
    var delRef = admin.database().ref("stripeComReq/" + key).remove();

    return admin.database().ref("stripeComRes/" + key).update(obj);

}

app.listen(app.get('port'), function() {
    console.log('Node app is running on port', app.get('port'));
});


