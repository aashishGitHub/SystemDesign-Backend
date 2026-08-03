
What are the core entities of the system?
Core entities are the fundamental components of your system's data model. They represent the primary objects your API will interact with and that your system will persist. They can also be thought of as the major tables in your database

Means all the nouns
    User
    order
    menu items
    Restaurants
    Delivery pilots
    payment service / provider
    search
    Notification



API 
GET https://www.swiggy.com/search?lat=LAT&long=LONG&items="rice, dal"

POST https://www.swiggy.com/order
body 
{
    menu: "01"
    menuVersion: "09"
    "items": [
                { item: "01", quanity: 2 }
             ]
total: 402.00
lat: "10373"
lang: "7535"

}