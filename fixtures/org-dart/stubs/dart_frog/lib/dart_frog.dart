/// Stand-in for package:dart_frog.
class RequestContext {}

class Response {
  Response({this.body = ''});
  final String body;
}

typedef Handler = Response Function(RequestContext context);
